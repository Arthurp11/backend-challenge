import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertLedgerInvariant } from '../support/ledger-invariant';
import { createWallet, startTestApp, type TestApp, wagerRequest } from '../support/test-app';
import { useTestDatabase } from '../support/test-database';

/*
 * §13 concurrency 1 and 2, with real parallelism: all requests are in flight at the same time and hit
 * PostgreSQL as concurrent transactions. The wallet row lock is what keeps the result correct.
 */

let app: TestApp;
let orm: MikroORM;
beforeAll(async () => {
  orm = await useTestDatabase();
  app = await startTestApp();
});
afterAll(() => app.close());

const ledgerEntries = async (walletId: string) => {
  const [row] = await orm.em.fork().getConnection().execute(
    `select count(*)::int as entries,
            count(*) filter (where direction = 'DEBIT')::int as debits
       from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  );
  return row as { entries: number; debits: number };
};

const balanceOf = async (walletId: string) => (await app.get(`/wallets/${walletId}`)).body.balance.amount;

describe('concurrency on a single wallet', () => {
  it('the same BET sent 50 times in parallel debits exactly once', async () => {
    const wallet = await createWallet(app, '1000.00');
    const bet = wagerRequest(wallet, { money: { amount: '25.00', currency: 'BRL' } });

    const responses = await Promise.all(Array.from({ length: 50 }, () => app.post('/wagering/transactions', bet.body, bet.headers)));

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 200)).toHaveLength(49);
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(responses.every((response) => response.body.balance.amount === '975.00')).toBe(true);
    expect(await balanceOf(wallet.id)).toBe('975.00');
    expect(await ledgerEntries(wallet.id)).toEqual({ entries: 2, debits: 1 }); // OPENING credit + one debit
    await assertLedgerInvariant(orm, wallet.id);
  });

  it('§8: from 100.00, two BETs of 80.00 at the same time -> one PROCESSED, one REJECTED, balance 20.00', async () => {
    // Repeated on fresh wallets: a race that only shows up sometimes must not slip through.
    for (let round = 0; round < 10; round++) {
      const wallet = await createWallet(app, '100.00');
      const first = wagerRequest(wallet, { money: { amount: '80.00', currency: 'BRL' } });
      const second = wagerRequest(wallet, { money: { amount: '80.00', currency: 'BRL' } });

      const responses = await Promise.all([first, second].map((bet) => app.post('/wagering/transactions', bet.body, bet.headers)));

      expect(responses.map((response) => response.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
      expect(responses.find((response) => response.body.status === 'REJECTED')?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await balanceOf(wallet.id)).toBe('20.00');
      expect((await ledgerEntries(wallet.id)).debits).toBe(1);
      await assertLedgerInvariant(orm, wallet.id);

      // Retrying both (same keys) changes nothing: the rejected one stays rejected, no second debit.
      await Promise.all([first, second].map((bet) => app.post('/wagering/transactions', bet.body, bet.headers)));
      expect((await ledgerEntries(wallet.id)).debits).toBe(1);
    }
  });

  it('a hot wallet: 40 different BETs of 10.00 against 100.00 -> exactly 10 processed, never negative', async () => {
    const wallet = await createWallet(app, '100.00');
    const bets = Array.from({ length: 40 }, () => wagerRequest(wallet, { money: { amount: '10.00', currency: 'BRL' } }));

    const responses = await Promise.all(bets.map((bet) => app.post('/wagering/transactions', bet.body, bet.headers)));

    const processed = responses.filter((response) => response.body.status === 'PROCESSED');
    expect(processed).toHaveLength(10);
    expect(responses.filter((response) => response.body.status === 'REJECTED')).toHaveLength(30);
    expect(await balanceOf(wallet.id)).toBe('0.00');
    // Every observed balance is a distinct step of the same serial history: 90.00, 80.00 … 0.00.
    const observed = processed.map((response) => response.body.balance.amount).sort();
    expect(observed).toEqual(['0.00', '10.00', '20.00', '30.00', '40.00', '50.00', '60.00', '70.00', '80.00', '90.00']);
    await assertLedgerInvariant(orm, wallet.id);
  });

  it('the same key with different payloads in parallel: one applies, the others are conflicts', async () => {
    const wallet = await createWallet(app, '100.00');
    const base = wagerRequest(wallet);
    const variants = ['1.00', '2.00', '3.00', '4.00', '5.00'].map((amount) => ({
      body: { ...base.body, money: { amount, currency: 'BRL' } },
      headers: base.headers,
    }));

    const responses = await Promise.all(variants.map((bet) => app.post('/wagering/transactions', bet.body, bet.headers)));

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(4);
    expect((await ledgerEntries(wallet.id)).debits).toBe(1);
    await assertLedgerInvariant(orm, wallet.id);
  });
});
