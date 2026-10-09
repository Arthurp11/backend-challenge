import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertLedgerInvariant } from '../support/ledger-invariant';
import { createWallet, startTestApp, type TestApp, wagerRequest } from '../support/test-app';
import { useTestDatabase } from '../support/test-database';

/* §13 concurrency 3: different wallets are processed in parallel (the lock is per wallet, never global). */

let app: TestApp;
let orm: MikroORM;
beforeAll(async () => {
  orm = await useTestDatabase();
  app = await startTestApp();
});
afterAll(() => app.close());

describe('concurrency across wallets', () => {
  it('10 wallets x 10 mixed operations, all in flight at once, end consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(app, '100.00')));
    const requests = wallets.flatMap((wallet) => [
      ...Array.from({ length: 6 }, () => wagerRequest(wallet, { money: { amount: '10.00', currency: 'BRL' } })),
      ...Array.from({ length: 3 }, () => wagerRequest(wallet, { kind: 'WIN', money: { amount: '5.00', currency: 'BRL' } })),
      wagerRequest(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }),
    ]);

    const responses = await Promise.all(requests.map((request) => app.post('/wagering/transactions', request.body, request.headers)));

    expect(responses.every((response) => response.status === 201)).toBe(true);
    for (const wallet of wallets) {
      const { body } = await app.get(`/wallets/${wallet.id}`);
      expect(body.balance.amount).toBe('55.00'); // 100 - 6×10 + 3×5
      expect(body.version).toBe(10); // 1 + 9 balance changes (the LOSS does not bump it)
      await assertLedgerInvariant(orm, wallet.id);
    }
  });

  it('a slow transaction on one wallet does not block another wallet', async () => {
    const [busy, free] = await Promise.all([createWallet(app), createWallet(app)]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const connection = orm.em.fork();
    const holder = connection.transactional(async (em) => {
      await em.execute('select id from wallets where id = ? for update', [busy.id]);
      await held;
    });
    await Bun.sleep(50);

    const bet = wagerRequest(free);
    const started = performance.now();
    const response = await app.post('/wagering/transactions', bet.body, bet.headers);
    const elapsed = performance.now() - started;

    release();
    await holder;
    expect(response.status).toBe(201);
    expect(elapsed).toBeLessThan(1_000);
  });
});
