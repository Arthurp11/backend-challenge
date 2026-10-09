import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';

/**
 * The final invariant of every test (§13): wallet.balance == balance rebuilt from the ledger.
 * Also checks that entries form an unbroken chain and that the last entry carries the wallet version.
 * One statement per check, so each reads a single consistent snapshot.
 */
export async function assertLedgerInvariant(orm: MikroORM, walletId: string): Promise<void> {
  const connection = orm.em.fork().getConnection();

  const [totals] = await connection.execute(
    `select w.balance_amount as stored,
            w.version,
            coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(20, 2) as rebuilt,
            coalesce(max(e.wallet_version), 0) as last_version,
            count(e.id)::int as entries
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ?
      group by w.id`,
    [walletId],
  );
  expect(totals, `wallet ${walletId} not found`).toBeDefined();
  expect(totals!.rebuilt, 'balance rebuilt from the ledger').toBe(totals!.stored);
  if (totals!.entries > 0) {
    expect(totals!.last_version, 'last ledger entry carries the wallet version').toBe(totals!.version);
  } else {
    expect(totals!.version, 'a wallet without entries is still at version 1').toBe(1);
  }

  const [chain] = await connection.execute(
    `select count(*)::int as breaks
       from (select balance_before,
                    lag(balance_after) over (order by wallet_version) as previous_after,
                    wallet_version - lag(wallet_version) over (order by wallet_version) as version_step
               from wallet_ledger_entries
              where wallet_id = ?) chained
      where previous_after is not null and (balance_before <> previous_after or version_step <> 1)`,
    [walletId],
  );
  expect(chain!.breaks, 'each entry starts where the previous one ended').toBe(0);
}
