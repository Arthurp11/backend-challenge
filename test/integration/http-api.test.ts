import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertLedgerInvariant } from '../support/ledger-invariant';
import { createWallet, startTestApp, type TestApp, uuid, wagerRequest } from '../support/test-app';
import { useTestDatabase } from '../support/test-database';

let app: TestApp;
let orm: MikroORM;
beforeAll(async () => {
  orm = await useTestDatabase();
  app = await startTestApp();
});
afterAll(() => app.close());

const submit = (request: { body: unknown; headers: Record<string, string> }) =>
  app.post('/wagering/transactions', request.body, request.headers);

const outboxTypes = async (walletId: string) => {
  const rows = await orm.em.fork().getConnection().execute(
    'select event_type from outbox_messages where aggregate_id = ? order by id',
    [walletId],
  );
  return rows.map((row) => row.event_type);
};

describe('HTTP API', () => {
  describe('POST /wallets', () => {
    it('creates a wallet at version 1, with an OPENING credit and its events', async () => {
      const playerId = uuid();

      const response = await app.post('/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
      expect(await outboxTypes(response.body.id)).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed']);
      await assertLedgerInvariant(orm, response.body.id);
    });

    it('creates a zero-balance wallet without a ledger entry', async () => {
      const wallet = await createWallet(app, '0.00');

      await assertLedgerInvariant(orm, wallet.id);
      expect(await outboxTypes(wallet.id)).toEqual([]);
    });

    it('a second wallet for the same player and currency is a conflict (409)', async () => {
      const wallet = await createWallet(app);

      const duplicate = await app.post('/wallets', { playerId: wallet.playerId, initialBalance: { amount: '5.00', currency: 'BRL' } });

      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('WALLET_ALREADY_EXISTS');
    });

    it.each([
      ['amount as a number', { amount: 10, currency: 'BRL' }],
      ['more than 2 decimals', { amount: '10.005', currency: 'BRL' }],
      ['a negative amount', { amount: '-1.00', currency: 'BRL' }],
      ['an invalid currency', { amount: '1.00', currency: 'real' }],
    ])('rejects %s (400)', async (_case, initialBalance) => {
      const response = await app.post('/wallets', { playerId: uuid(), initialBalance });

      expect(response.status).toBe(400);
      expect(response.body.retryable).toBe(false);
    });
  });

  describe('GET /wallets/:walletId', () => {
    it('returns the wallet, 404 when unknown and 400 for a malformed id', async () => {
      const wallet = await createWallet(app);

      expect((await app.get(`/wallets/${wallet.id}`)).status).toBe(200);
      expect((await app.get(`/wallets/${uuid()}`)).status).toBe(404);
      expect((await app.get('/wallets/not-a-uuid')).status).toBe(400);
    });
  });

  describe('POST /wagering/transactions', () => {
    it('processes a BET (201) and returns the resulting balance', async () => {
      const wallet = await createWallet(app, '1000.00');

      const response = await submit(wagerRequest(wallet));

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: '975.00', currency: 'BRL' },
        failureCode: null,
        idempotentReplay: false,
      });
      expect(await outboxTypes(wallet.id)).toEqual([
        'WalletBalanceChanged',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
        'WagerTransactionProcessed',
      ]);
      await assertLedgerInvariant(orm, wallet.id);
    });

    it('a repeated request is a replay (200) with the original result, even after the balance moved', async () => {
      const wallet = await createWallet(app, '100.00');
      const bet = wagerRequest(wallet);
      const first = await submit(bet);
      await submit(wagerRequest(wallet, { money: { amount: '10.00', currency: 'BRL' } }));

      const replay = await submit(bet);

      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(replay.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
      await assertLedgerInvariant(orm, wallet.id);
    });

    it('"25" and "25.00" are the same request (replay, not conflict)', async () => {
      const wallet = await createWallet(app);
      const bet = wagerRequest(wallet);
      await submit(bet);

      const replay = await submit({ ...bet, body: { ...bet.body, money: { amount: '25', currency: 'BRL' } } });

      expect(replay.status).toBe(200);
    });

    it('the same key with a different payload is a conflict (409), never a replay', async () => {
      const wallet = await createWallet(app);
      const bet = wagerRequest(wallet);
      await submit(bet);

      const conflicting = await submit({ ...bet, body: { ...bet.body, money: { amount: '26.00', currency: 'BRL' } } });

      expect(conflicting.status).toBe(409);
      expect(conflicting.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      await assertLedgerInvariant(orm, wallet.id);
    });

    it('the provider transaction id under another key is a conflict (409)', async () => {
      const wallet = await createWallet(app);
      const bet = wagerRequest(wallet);
      await submit(bet);

      const reused = await submit({ ...bet, headers: { 'Idempotency-Key': 'another-key' } });

      expect(reused.status).toBe(409);
      expect(reused.body.code).toBe('EXTERNAL_ID_CONFLICT');
    });

    it('a business rejection is 422 with a failureCode, persisted and replayed identically', async () => {
      const wallet = await createWallet(app, '10.00');
      const bet = wagerRequest(wallet);

      const rejected = await submit(bet);
      const replay = await submit(bet);

      expect(rejected.status).toBe(422);
      expect(rejected.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00', currency: 'BRL' } });
      expect(replay.status).toBe(422);
      expect(replay.body.idempotentReplay).toBe(true);
      expect(await outboxTypes(wallet.id)).toContain('WagerTransactionRejected');
      await assertLedgerInvariant(orm, wallet.id);
    });

    it('a REFUND before its BET is accepted for later processing (202 PENDING_REFERENCE)', async () => {
      const wallet = await createWallet(app);

      const refund = await submit(wagerRequest(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-not-here-yet' }));

      expect(refund.status).toBe(202);
      expect(refund.body.status).toBe('PENDING_REFERENCE');
      expect(await outboxTypes(wallet.id)).toContain('WagerTransactionPendingReference');
    });

    it('a REFUND of a processed BET credits it back', async () => {
      const wallet = await createWallet(app, '100.00');
      const bet = wagerRequest(wallet);
      await submit(bet);

      const refund = await submit(
        wagerRequest(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.body.externalTransactionId }),
      );

      expect(refund.status).toBe(201);
      expect(refund.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
      await assertLedgerInvariant(orm, wallet.id);
    });

    it('rejects a currency different from the wallet with CURRENCY_MISMATCH (422)', async () => {
      const wallet = await createWallet(app);

      const response = await submit(wagerRequest(wallet, { money: { amount: '5.00', currency: 'USD' } }));

      expect(response.status).toBe(422);
      expect(response.body.failureCode).toBe('CURRENCY_MISMATCH');
      expect(response.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    });

    it.each([
      ['a missing Idempotency-Key', (r: ReturnType<typeof wagerRequest>) => ({ ...r, headers: {} })],
      ['the internal OPENING kind', (r: ReturnType<typeof wagerRequest>) => ({ ...r, body: { ...r.body, kind: 'OPENING' } })],
      ['an unknown field', (r: ReturnType<typeof wagerRequest>) => ({ ...r, body: { ...r.body, bonus: true } })],
      ['a REFUND without reference', (r: ReturnType<typeof wagerRequest>) => ({ ...r, body: { ...r.body, kind: 'REFUND' } })],
      ['an amount in scientific notation', (r: ReturnType<typeof wagerRequest>) => ({ ...r, body: { ...r.body, money: { amount: '1e3', currency: 'BRL' } } })],
    ])('rejects %s as an invalid request (400, nothing persisted)', async (_case, mutate) => {
      const wallet = await createWallet(app);

      const response = await submit(mutate(wagerRequest(wallet)));

      expect(response.status).toBe(400);
      await assertLedgerInvariant(orm, wallet.id);
    });

    it('an unknown wallet is 404', async () => {
      const response = await submit(wagerRequest({ id: uuid(), playerId: uuid() }));

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('WALLET_NOT_FOUND');
    });
  });

  describe('GET transactions', () => {
    it('finds a transaction by internal id and by provider id', async () => {
      const wallet = await createWallet(app);
      const bet = wagerRequest(wallet);
      const { body } = await submit(bet);

      const byId = await app.get(`/wagering/transactions/${body.transactionId}`);
      const byExternal = await app.get(`/providers/provider-a/wagering/transactions/${bet.body.externalTransactionId}`);

      expect(byId.status).toBe(200);
      expect(byId.body).toMatchObject({ id: body.transactionId, kind: 'BET', status: 'PROCESSED', money: { amount: '25.00', currency: 'BRL' } });
      expect(byExternal.body).toEqual(byId.body);
      expect((await app.get(`/wagering/transactions/${uuid()}`)).status).toBe(404);
    });
  });
});
