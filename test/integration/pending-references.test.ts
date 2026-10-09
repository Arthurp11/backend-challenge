import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { eventually } from '../support/eventually';
import { assertLedgerInvariant } from '../support/ledger-invariant';
import { createWallet, startTestApp, type TestApp, wagerRequest } from '../support/test-app';
import { useTestDatabase } from '../support/test-database';

/* §13 concurrency 7 and §7.1: a REFUND / ROLLBACK delivered before its reference. */

let app: TestApp;
let orm: MikroORM;
beforeAll(async () => {
  orm = await useTestDatabase();
  app = await startTestApp({
    RUN_PENDING_REFERENCE_WORKER: 'true',
    PENDING_REFERENCE_POLL_MS: '50',
    REFERENCE_RETRY_BASE_MS: '50',
    REFERENCE_RETRY_MAX_MS: '200',
    REFERENCE_RETRY_MAX_ATTEMPTS: '4',
  });
});
afterAll(() => app.close());

const submit = (request: ReturnType<typeof wagerRequest>) => app.post('/wagering/transactions', request.body, request.headers);
const transaction = (id: string) => app.get(`/wagering/transactions/${id}`).then((response) => response.body);
const eventTypes = async (walletId: string) =>
  (await orm.em.fork().getConnection().execute('select event_type from outbox_messages where aggregate_id = ? order by id', [walletId])).map(
    (row) => row.event_type,
  );

describe('references that arrive late', () => {
  it('a REFUND sent before its BET waits, then is applied by the worker once the BET arrives', async () => {
    const wallet = await createWallet(app, '100.00');
    const bet = wagerRequest(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const refund = wagerRequest(wallet, {
      kind: 'REFUND',
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.body.externalTransactionId,
    });

    const early = await submit(refund);
    expect(early.status).toBe(202);
    expect((await submit(bet)).status).toBe(201);

    await eventually(async () => expect((await transaction(early.body.transactionId)).status).toBe('PROCESSED'));
    expect((await app.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('100.00');
    // A replay after the resolution returns the final state, not the original 202.
    const replay = await submit(refund);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });
    expect(await eventTypes(wallet.id)).toContain('WagerTransactionPendingReference');
    await assertLedgerInvariant(orm, wallet.id);
  });

  it('a ROLLBACK of a WIN that arrives first is applied in the right direction (debit)', async () => {
    const wallet = await createWallet(app, '100.00');
    const win = wagerRequest(wallet, { kind: 'WIN', money: { amount: '40.00', currency: 'BRL' } });
    const rollback = wagerRequest(wallet, {
      kind: 'ROLLBACK',
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: win.body.externalTransactionId,
    });

    const early = await submit(rollback);
    await submit(win);

    await eventually(async () => expect((await transaction(early.body.transactionId)).status).toBe('PROCESSED'));
    expect((await app.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('100.00');
    await assertLedgerInvariant(orm, wallet.id);
  });

  it('a reference that never arrives ends REJECTED with REFERENCE_NOT_FOUND, with its event', async () => {
    const wallet = await createWallet(app, '100.00');
    const orphan = await submit(
      wagerRequest(wallet, { kind: 'ROLLBACK', money: { amount: '5.00', currency: 'BRL' }, referenceExternalTransactionId: 'never-sent' }),
    );

    const final = await eventually(async () => {
      const current = await transaction(orphan.body.transactionId);
      expect(current.status).toBe('REJECTED');
      return current;
    });

    expect(final.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(await eventTypes(wallet.id)).toContain('WagerTransactionRejected');
    expect((await app.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('100.00');
    await assertLedgerInvariant(orm, wallet.id);
  });

  it('two REFUNDs of the same late BET: exactly one is applied, the other is ALREADY_REVERSED', async () => {
    const wallet = await createWallet(app, '100.00');
    const bet = wagerRequest(wallet, { money: { amount: '20.00', currency: 'BRL' } });
    const reversal = { kind: 'REFUND', money: { amount: '20.00', currency: 'BRL' }, referenceExternalTransactionId: bet.body.externalTransactionId };
    const [first, second] = await Promise.all([submit(wagerRequest(wallet, reversal)), submit(wagerRequest(wallet, reversal))]);
    await submit(bet);

    const statuses = await eventually(async () => {
      const both = await Promise.all([transaction(first.body.transactionId), transaction(second.body.transactionId)]);
      expect(both.every((t) => t.status !== 'PENDING_REFERENCE')).toBe(true);
      return both;
    });

    expect(statuses.map((t) => t.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(statuses.find((t) => t.status === 'REJECTED')?.failureCode).toBe('ALREADY_REVERSED');
    expect((await app.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('100.00');
    await assertLedgerInvariant(orm, wallet.id);
  });
});
