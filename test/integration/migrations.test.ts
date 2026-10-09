import { beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { migrateTestDatabase, useTestDatabase } from '../support/test-database';

let orm: MikroORM;
beforeAll(async () => {
  orm = await useTestDatabase();
});

const tables = async () => {
  const rows = await orm.em.fork().getConnection().execute(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by table_name`,
  );
  return rows.map((row) => row.table_name);
};

describe('migrations', () => {
  it('are reversible: down removes everything, up restores the same schema', async () => {
    const before = await tables();

    expect(await migrateTestDatabase('down')).toEqual(['Migration0001InitialSchema']);
    expect(await tables()).toEqual([]);
    expect(await migrateTestDatabase('up')).toEqual(['Migration0001InitialSchema']);

    expect(await tables()).toEqual(before);
    expect(before).toEqual(['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets']);
  });
});
