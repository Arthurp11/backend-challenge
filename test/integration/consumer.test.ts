import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { eventually } from '../support/eventually';
import { assertLedgerInvariant } from '../support/ledger-invariant';
import { createWallet, startTestApp, type TestApp, wagerRequest } from '../support/test-app';
import { useTestDatabase } from '../support/test-database';
import { createTestQueues, type TestQueues, wagerMessage } from '../support/test-queues';

/* §10: SQS consumer with persistent inbox, redelivery, retry with backoff and DLQ. */

let app: TestApp;
let orm: MikroORM;
let queues: TestQueues;
beforeAll(async () => {
  orm = await useTestDatabase();
  queues = await createTestQueues('consumer', { maxReceiveCount: 2, visibilityTimeoutSeconds: 2 });
  app = await startTestApp({ ...queues.env, RUN_CONSUMER: 'true', DB_LOCK_TIMEOUT_MS: '300', TRANSIENT_RETRIES: '0' });
});
afterAll(async () => {
  await app.close();
  queues.close();
});

const sql = (query: string, params: unknown[] = []) => orm.em.fork().getConnection().execute(query, params);
const byKey = async (key: string) => (await sql('select status, failure_code from wager_transactions where idempotency_key = ?', [key]))[0];
const debits = async (walletId: string) =>
  (await sql(`select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]))[0]!.n;

describe('wager queue consumer', () => {
  it('processes a message through the same use case and records it in the inbox', async () => {
    const wallet = await createWallet(app, '100.00');
    const message = wagerMessage(wallet);

    await queues.send(message);

    await eventually(async () => expect((await byKey(message.data.idempotencyKey))?.status).toBe('PROCESSED'));
    const [inbox] = await sql('select consumer_name, processed_at from inbox_messages where message_id = ?', [message.messageId]);
    expect(inbox?.processed_at).not.toBeNull();
    expect((await app.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('90.00');
    await assertLedgerInvariant(orm, wallet.id);
  });

  it('a redelivered message (same messageId) has no second effect', async () => {
    const wallet = await createWallet(app, '100.00');
    const message = wagerMessage(wallet);

    await queues.send(message);
    await queues.send(message);
    await queues.send(message);

    await eventually(async () => expect((await byKey(message.data.idempotencyKey))?.status).toBe('PROCESSED'));
    await Bun.sleep(1_500);
    expect(await debits(wallet.id)).toBe(1);
    expect((await sql('select count(*)::int as n from inbox_messages where message_id = ?', [message.messageId]))[0]!.n).toBe(1);
    await assertLedgerInvariant(orm, wallet.id);
  });

  it('HTTP and queue share idempotency: the same transaction through both applies once', async () => {
    const wallet = await createWallet(app, '100.00');
    const message = wagerMessage(wallet);
    const viaHttp = wagerRequest(wallet, { ...message.data, idempotencyKey: undefined });
    delete (viaHttp.body as Record<string, unknown>).idempotencyKey;

    expect((await app.post('/wagering/transactions', viaHttp.body, { 'Idempotency-Key': message.data.idempotencyKey })).status).toBe(201);
    await queues.send(message);

    await eventually(async () =>
      expect((await sql('select count(*)::int as n from inbox_messages where message_id = ?', [message.messageId]))[0]!.n).toBe(1),
    );
    expect(await debits(wallet.id)).toBe(1);
  });

  it('a business rejection is acked (persisted as REJECTED), not dead-lettered', async () => {
    const wallet = await createWallet(app, '5.00');
    const message = wagerMessage(wallet, { money: { amount: '10.00', currency: 'BRL' } });

    await queues.send(message);

    await eventually(async () => expect((await byKey(message.data.idempotencyKey))?.failure_code).toBe('INSUFFICIENT_FUNDS'));
  });

  it('permanent failures go to the DLQ with their reason: malformed message, conflicting redelivery', async () => {
    const wallet = await createWallet(app, '100.00');
    const message = wagerMessage(wallet);
    await queues.send(message);
    await eventually(async () => expect((await byKey(message.data.idempotencyKey))?.status).toBe('PROCESSED'));

    await queues.send(null, { raw: '{ not json', groupId: 'poison' });
    await queues.send({ ...message, data: { ...message.data, money: { amount: '99.00', currency: 'BRL' } } });

    const deadLetters = await eventually(async () => {
      const received = await queues.drain('deadLetterQueue');
      expect(received.length).toBeGreaterThanOrEqual(2);
      return received;
    }, 15_000);
    const reasons = deadLetters.map((m) => m.MessageAttributes?.failureReason?.StringValue).sort();
    expect(reasons).toEqual(['INBOX_PAYLOAD_CONFLICT', 'INVALID_MESSAGE']);
    expect(await debits(wallet.id)).toBe(1);
  });

  it('a transient failure is retried with backoff and succeeds once the cause goes away', async () => {
    const wallet = await createWallet(app, '100.00');
    const message = wagerMessage(wallet);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const blocker = orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id = ? for update', [wallet.id]);
      await held;
    });

    await queues.send(message);
    await Bun.sleep(1_000); // first delivery hits the lock timeout and is put back with a delay
    expect(await byKey(message.data.idempotencyKey)).toBeUndefined();
    release();
    await blocker;

    await eventually(async () => expect((await byKey(message.data.idempotencyKey))?.status).toBe('PROCESSED'), 15_000);
    await assertLedgerInvariant(orm, wallet.id);
  });

  it('a failure that persists past maxReceiveCount ends in the DLQ via the redrive policy', async () => {
    const wallet = await createWallet(app, '100.00');
    const message = wagerMessage(wallet);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const blocker = orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id = ? for update', [wallet.id]);
      await held;
    });

    await queues.send(message);
    const deadLetters = await eventually(async () => {
      const received = await queues.drain('deadLetterQueue');
      expect(received).toHaveLength(1);
      return received;
    }, 20_000, 500);
    release();
    await blocker;

    expect(JSON.parse(deadLetters[0]!.Body ?? '{}').messageId).toBe(message.messageId);
    expect(await byKey(message.data.idempotencyKey)).toBeUndefined();
  });
});
