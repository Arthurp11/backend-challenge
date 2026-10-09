import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { EventPublisher } from '../../src/application/ports/event-publisher';
import { PublishOutbox } from '../../src/application/use-cases/publish-outbox';
import { BackoffPolicy } from '../../src/domain/shared/backoff-policy';
import { QueueUrls } from '../../src/infrastructure/messaging/queue-urls';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../../src/infrastructure/runtime/system-clock';
import { createWallet, startTestApp, type TestApp, wagerRequest } from '../support/test-app';
import { useTestDatabase } from '../support/test-database';
import { createTestQueues, type TestQueues } from '../support/test-queues';

/* §11 and §13 concurrency 6: publishers on the same outbox, at-least-once, nothing lost. */

let app: TestApp;
let orm: MikroORM;
let queues: TestQueues;
const retry = BackoffPolicy.exponential({ baseDelayMs: 50, maxDelayMs: 200, maxAttempts: Number.MAX_SAFE_INTEGER });

beforeAll(async () => {
  orm = await useTestDatabase();
  queues = await createTestQueues('outbox');
  app = await startTestApp(queues.env);
});
afterAll(async () => {
  await app.close();
  queues.close();
});

function publisherFor(eventPublisher: EventPublisher): PublishOutbox {
  return new PublishOutbox(new MikroOrmUnitOfWork(orm), eventPublisher, new SystemClock(), { batchSize: 10, retry });
}

const sqsPublisher = () => new SqsEventPublisher(queues.sqs, new QueueUrls(queues.sqs), queues.names.eventsQueue);

async function drainOutbox(publisher: PublishOutbox): Promise<number> {
  let published = 0;
  for (;;) {
    const result = await publisher.runOnce();
    published += result.published;
    if (result.claimed === 0) return published;
  }
}

describe('transactional outbox', () => {
  it('two concurrent publishers deliver every committed event exactly once between them (SKIP LOCKED)', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet(app, '100.00')));
    await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 6 }, () => {
          const bet = wagerRequest(wallet, { money: { amount: '1.00', currency: 'BRL' } });
          return app.post('/wagering/transactions', bet.body, bet.headers);
        }),
      ),
    );

    const [a, b] = await Promise.all([drainOutbox(publisherFor(sqsPublisher())), drainOutbox(publisherFor(sqsPublisher()))]);

    const [backlog] = await orm.em.fork().getConnection().execute('select count(*)::int as pending from outbox_messages where published_at is null');
    expect(backlog?.pending).toBe(0);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0); // both really worked in parallel

    const delivered = (await queues.drain('eventsQueue')).map((message) => JSON.parse(message.Body ?? '{}').eventId as string);
    expect(delivered.length).toBe(a + b);
    expect(new Set(delivered).size).toBe(delivered.length); // no duplicates
    const ours = await orm.em
      .fork()
      .getConnection()
      .execute(`select id from outbox_messages where aggregate_id in (${wallets.map(() => '?').join(',')})`, wallets.map((w) => w.id));
    expect(ours).toHaveLength(5 * (2 + 6 * 2)); // per wallet: opening (2 events) + 6 bets × 2 events
    for (const { id } of ours) {
      expect(delivered).toContain(id);
    }
  });

  it('a failed publish is kept, rescheduled with its error, and delivered later', async () => {
    const wallet = await createWallet(app, '10.00');
    const failing = publisherFor({
      publish: async () => {
        throw new Error('broker unavailable');
      },
    });

    await failing.runOnce();
    const [row] = await orm.em
      .fork()
      .getConnection()
      .execute('select attempts, last_error, published_at from outbox_messages where aggregate_id = ? order by id limit 1', [wallet.id]);
    expect(row).toMatchObject({ attempts: 1, last_error: 'broker unavailable', published_at: null });

    await Bun.sleep(100);
    await drainOutbox(publisherFor(sqsPublisher()));
    const [after] = await orm.em
      .fork()
      .getConnection()
      .execute('select count(*)::int as pending from outbox_messages where aggregate_id = ? and published_at is null', [wallet.id]);
    expect(after?.pending).toBe(0);
    await queues.drain('eventsQueue');
  });

  it('events carry the envelope: eventType, version, walletId as aggregate and money as decimal strings', async () => {
    const wallet = await createWallet(app, '50.00');
    await drainOutbox(publisherFor(sqsPublisher()));

    const events = (await queues.drain('eventsQueue')).map((message) => JSON.parse(message.Body ?? '{}'));
    const balanceChanged = events.find((event) => event.eventType === 'WalletBalanceChanged' && event.aggregateId === wallet.id);
    expect(balanceChanged).toMatchObject({
      version: 1,
      data: { walletId: wallet.id, direction: 'CREDIT', balanceAfter: { amount: '50.00', currency: 'BRL' }, walletVersion: 1 },
    });
  });
});
