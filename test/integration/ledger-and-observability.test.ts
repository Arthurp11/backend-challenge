import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createWallet, startTestApp, type TestApp, wagerRequest } from '../support/test-app';
import { useTestDatabase } from '../support/test-database';

let app: TestApp;
let orm: MikroORM;
beforeAll(async () => {
  orm = await useTestDatabase();
  app = await startTestApp();
});
afterAll(() => app.close());

async function walletWithBets(count: number) {
  const wallet = await createWallet(app, '100.00');
  for (let i = 0; i < count; i++) {
    const bet = wagerRequest(wallet, { money: { amount: '1.00', currency: 'BRL' } });
    await app.post('/wagering/transactions', bet.body, bet.headers);
  }
  return wallet;
}

describe('GET /wallets/:walletId/ledger', () => {
  it('pages through the ledger with a stable, opaque cursor', async () => {
    const wallet = await walletWithBets(4); // 1 opening + 4 debits

    const first = await app.get(`/wallets/${wallet.id}/ledger?limit=2`);
    const second = await app.get(`/wallets/${wallet.id}/ledger?limit=2&cursor=${first.body.nextCursor}`);
    const third = await app.get(`/wallets/${wallet.id}/ledger?limit=2&cursor=${second.body.nextCursor}`);

    const versions = [first, second, third].flatMap((page) => page.body.items.map((item: { walletVersion: number }) => item.walletVersion));
    expect(versions).toEqual([1, 2, 3, 4, 5]);
    expect(third.body.nextCursor).toBeNull();
    expect(first.body.items[0]).toMatchObject({ direction: 'CREDIT', balanceAfter: { amount: '100.00', currency: 'BRL' } });
  });

  it('rejects a malformed cursor (400) and an unknown wallet (404)', async () => {
    const wallet = await walletWithBets(0);

    expect((await app.get(`/wallets/${wallet.id}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await app.get(`/wallets/${Bun.randomUUIDv7()}/ledger`)).status).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  it('reports a consistent wallet', async () => {
    const wallet = await walletWithBets(3);

    const { status, body } = await app.post(`/wallets/${wallet.id}/reconciliation`, {});

    expect(status).toBe(200);
    expect(body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '97.00', currency: 'BRL' },
      calculatedBalance: { amount: '97.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 4,
      issues: [],
    });
  });

  it('flags a divergence (it never corrects it), even one forced past the schema guards', async () => {
    const wallet = await walletWithBets(1);
    // Simulates corruption that bypassed the application and the deferred trigger.
    await orm.em.fork().transactional(async (em) => {
      await em.execute('alter table wallets disable trigger wallets_balance_change_is_ledgered');
      await em.execute(`update wallets set balance_amount = balance_amount + 1 where id = ?`, [wallet.id]);
      await em.execute('alter table wallets enable trigger wallets_balance_change_is_ledgered');
    });

    const { body } = await app.post(`/wallets/${wallet.id}/reconciliation`, {});

    expect(body).toMatchObject({
      consistent: false,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '99.00', currency: 'BRL' },
      difference: { amount: '1.00', currency: 'BRL' },
    });
    // Not corrected: the stored balance is still the divergent one.
    expect((await app.get(`/wallets/${wallet.id}`)).body.balance.amount).toBe('100.00');
    const metrics = await fetch(`${app.url}/metrics`).then((response) => response.text());
    expect(metrics).toMatch(/reconciliation_divergences_total [1-9]/);
  });
});

describe('observability', () => {
  it('exposes Prometheus metrics, including transactions by status and outbox lag', async () => {
    await walletWithBets(1);

    const response = await fetch(`${app.url}/metrics`);
    const text = await response.text();

    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(text).toContain('wager_transactions_total{status="PROCESSED",kind="BET",source="http"}');
    expect(text).toContain('outbox_lag_seconds');
    expect(text).toContain('wager_processing_duration_seconds_bucket');
  });

  it('echoes the caller correlation id, or creates one', async () => {
    const echoed = await fetch(`${app.url}/health/live`, { headers: { 'x-correlation-id': 'corr-123' } });
    const created = await fetch(`${app.url}/health/live`);

    expect(echoed.headers.get('x-correlation-id')).toBe('corr-123');
    expect(created.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
