import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { eventually } from '../support/eventually';
import { type Instance, spawnInstance } from '../support/instances';
import { assertLedgerInvariant } from '../support/ledger-invariant';
import { uuid, wagerRequest } from '../support/test-app';
import { useTestDatabase } from '../support/test-database';
import { createTestQueues, type TestQueues, wagerMessage } from '../support/test-queues';

/*
 * §13 concurrency 4, 5 and 8 with separate OS processes (`bun run src/main.ts`), not mocks:
 * three instances sharing PostgreSQL and SQS, a worker killed between commit and ack, a publisher
 * killed between publish and mark, and a restart in the middle of the load.
 */

let orm: MikroORM;
const running: Instance[] = [];
beforeAll(async () => {
  orm = await useTestDatabase();
});
afterAll(async () => {
  await Promise.all(running.map((instance) => instance.stop('SIGKILL')));
});

async function start(env: Record<string, string>, options?: { waitUntilLive?: boolean }): Promise<Instance> {
  const instance = await spawnInstance(env, options);
  running.push(instance);
  return instance;
}

const sql = (query: string, params: unknown[] = []) => orm.em.fork().getConnection().execute(query, params);

async function openWallet(instance: Instance, amount: string) {
  const { status, body } = await instance.post('/wallets', { playerId: uuid(), initialBalance: { amount, currency: 'BRL' } });
  expect(status).toBe(201);
  return body as { id: string; playerId: string };
}

describe('three instances at the same time', () => {
  let queues: TestQueues;
  let instances: Instance[];

  beforeAll(async () => {
    queues = await createTestQueues('multi', { visibilityTimeoutSeconds: 5 });
    const env = {
      ...queues.env,
      RUN_CONSUMER: 'true',
      RUN_OUTBOX_PUBLISHER: 'true',
      RUN_PENDING_REFERENCE_WORKER: 'true',
      OUTBOX_POLL_MS: '100',
      PENDING_REFERENCE_POLL_MS: '100',
      REFERENCE_RETRY_BASE_MS: '100',
      REFERENCE_RETRY_MAX_MS: '500',
      REFERENCE_RETRY_MAX_ATTEMPTS: '30',
    };
    instances = await Promise.all([start(env), start(env), start(env)]);
  });
  afterAll(async () => {
    // Stop them: their publishers would otherwise keep claiming outbox rows during the next tests.
    await Promise.all(instances.map((instance) => instance.stop('SIGTERM')));
    queues.close();
  });

  it('HTTP and SQS traffic with duplicates spread over 3 instances ends consistent, with every event published', async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, (_, i) => openWallet(instances[i % 3]!, '200.00')));
    const pick = (n: number) => instances[n % 3]!;

    await Promise.all(
      wallets.flatMap((wallet, w) => {
        // 20 BETs of 2.00 over HTTP, each sent to two different instances at once.
        const bets = Array.from({ length: 20 }, () => wagerRequest(wallet, { money: { amount: '2.00', currency: 'BRL' } }));
        const http = bets.flatMap((bet, i) => [pick(w + i).post('/wagering/transactions', bet.body, bet.headers), pick(w + i + 1).post('/wagering/transactions', bet.body, bet.headers)]);
        // 3 REFUNDs of those BETs, through the queue (they may arrive before their BET).
        const refunds = bets.slice(0, 3).map((bet) =>
          queues.send(wagerMessage(wallet, { kind: 'REFUND', providerId: 'provider-a', money: { amount: '2.00', currency: 'BRL' }, referenceExternalTransactionId: bet.body.externalTransactionId })),
        );
        // 10 BETs of 3.00 through the queue, each delivered twice (same messageId).
        const queued = Array.from({ length: 10 }, () => wagerMessage(wallet, { money: { amount: '3.00', currency: 'BRL' } })).flatMap((message) => [queues.send(message), queues.send(message)]);
        // 5 WINs of 1.00 over HTTP.
        const wins = Array.from({ length: 5 }, (_, i) => {
          const win = wagerRequest(wallet, { kind: 'WIN', money: { amount: '1.00', currency: 'BRL' } });
          return pick(w + i).post('/wagering/transactions', win.body, win.headers);
        });
        return [...http, ...refunds, ...queued, ...wins];
      }),
    );

    for (const wallet of wallets) {
      await eventually(async () => {
        const [state] = await sql(
          `select count(*) filter (where kind <> 'OPENING')::int as transactions,
                  count(*) filter (where status = 'PENDING_REFERENCE')::int as pending
             from wager_transactions where wallet_id = ?`,
          [wallet.id],
        );
        expect(state).toEqual({ transactions: 38, pending: 0 });
      }, 30_000, 250);

      // 200 − 20×2 − 10×3 + 5×1 + 3×2
      expect((await instances[0]!.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('141.00');
      const [entries] = await sql(
        `select count(*) filter (where direction = 'DEBIT')::int as debits, count(*) filter (where direction = 'CREDIT')::int as credits
           from wallet_ledger_entries where wallet_id = ?`,
        [wallet.id],
      );
      expect(entries).toEqual({ debits: 30, credits: 9 });
      await assertLedgerInvariant(orm, wallet.id);
      const reconciliation = await instances[2]!.post(`/wallets/${wallet.id}/reconciliation`, {});
      expect(reconciliation.body).toMatchObject({ consistent: true, checkedEntries: 39 });
    }

    // Every committed event of these wallets is eventually published by one of the three publishers.
    await eventually(async () => {
      const [backlog] = await sql(
        `select count(*)::int as pending from outbox_messages where published_at is null and aggregate_id in (${wallets.map(() => '?').join(',')})`,
        wallets.map((wallet) => wallet.id),
      );
      expect(backlog?.pending).toBe(0);
    }, 30_000, 250);
  }, 120_000);
});

describe('a worker killed after the commit and before the ack', () => {
  it('the redelivered message is recognized by the inbox and has no second effect', async () => {
    const queues = await createTestQueues('crash-ack', { visibilityTimeoutSeconds: 2 });
    try {
      const api = await start({});
      const wallet = await openWallet(api, '100.00');
      const crashing = await start({ ...queues.env, RUN_CONSUMER: 'true', FAULT_INJECTION: 'crash_after_commit_before_ack' });
      const message = wagerMessage(wallet, { money: { amount: '25.00', currency: 'BRL' } });

      await queues.send(message);
      await crashing.exited;

      expect(crashing.process.signalCode).toBe('SIGKILL');
      const [committed] = await sql('select status from wager_transactions where idempotency_key = ?', [message.data.idempotencyKey]);
      expect(committed?.status).toBe('PROCESSED'); // the commit happened, the ack did not

      const healthy = await start({ ...queues.env, RUN_CONSUMER: 'true' });
      await Bun.sleep(4_000); // visibility timeout expires, the message is redelivered and acked
      await healthy.stop('SIGTERM');

      expect(await queues.drain('wagerQueue')).toHaveLength(0);
      const [debits] = await sql(`select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [wallet.id]);
      expect(debits?.n).toBe(1);
      expect((await api.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('75.00');
      await assertLedgerInvariant(orm, wallet.id);
    } finally {
      queues.close();
    }
  }, 60_000);
});

describe('a publisher killed after publishing and before marking the outbox row', () => {
  it('another instance takes over: the event is published, and the duplicate is harmless', async () => {
    const queues = await createTestQueues('crash-outbox');
    try {
      const api = await start({});
      const wallet = await openWallet(api, '100.00');
      const crashing = await start(
        { ...queues.env, RUN_OUTBOX_PUBLISHER: 'true', OUTBOX_BATCH_SIZE: '1', FAULT_INJECTION: 'crash_after_publish_before_mark' },
        { waitUntilLive: false },
      );
      await crashing.exited;
      expect(crashing.process.signalCode).toBe('SIGKILL');

      const takeover = await start({ ...queues.env, RUN_OUTBOX_PUBLISHER: 'true', OUTBOX_POLL_MS: '50' });
      await eventually(async () => {
        const [backlog] = await sql('select count(*)::int as pending from outbox_messages where published_at is null');
        expect(backlog?.pending).toBe(0);
      }, 60_000, 250);
      await takeover.stop('SIGTERM');

      const delivered = (await queues.drain('eventsQueue')).map((m) => JSON.parse(m.Body ?? '{}').eventId as string);
      const ours = await sql('select id from outbox_messages where aggregate_id = ?', [wallet.id]);
      for (const { id } of ours) {
        expect(delivered).toContain(id);
      }
    } finally {
      queues.close();
    }
  }, 90_000);
});

describe('restart in the middle of the load', () => {
  it('after a SIGKILL mid-flight, a new instance and provider retries converge to one effect per request', async () => {
    const first = await start({});
    const wallet = await openWallet(first, '100.00');
    const bets = Array.from({ length: 30 }, () => wagerRequest(wallet, { money: { amount: '5.00', currency: 'BRL' } }));

    const inFlight = Promise.allSettled(bets.map((bet) => first.post('/wagering/transactions', bet.body, bet.headers)));
    await Bun.sleep(30);
    await first.stop('SIGKILL');
    await inFlight;

    const second = await start({});
    const retried = await Promise.all(bets.map((bet) => second.post('/wagering/transactions', bet.body, bet.headers)));

    const processed = retried.filter((response) => response.body.status === 'PROCESSED');
    const rejected = retried.filter((response) => response.body.status === 'REJECTED');
    expect(processed).toHaveLength(20); // 100.00 / 5.00
    expect(rejected).toHaveLength(10);
    expect((await second.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('0.00');
    const [rows] = await sql(`select count(*)::int as n from wager_transactions where wallet_id = ? and kind = 'BET'`, [wallet.id]);
    expect(rows?.n).toBe(30);
    await assertLedgerInvariant(orm, wallet.id);
  }, 60_000);

  it('SIGTERM drains gracefully: the process exits and committed work stays consistent', async () => {
    const instance = await start({});
    const wallet = await openWallet(instance, '50.00');
    const bet = wagerRequest(wallet, { money: { amount: '5.00', currency: 'BRL' } });
    expect((await instance.post('/wagering/transactions', bet.body, bet.headers)).status).toBe(201);

    await instance.stop('SIGTERM');

    expect(instance.process.signalCode === 'SIGTERM' || instance.process.exitCode === 0).toBe(true);
    await assertLedgerInvariant(orm, wallet.id);
  }, 30_000);
});
