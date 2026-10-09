import { MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';
import { loadEnv } from '../src/infrastructure/config/env';
import { buildOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';

const command = process.argv[2];
const env = loadEnv();

/**
 * MikroORM's migrator takes no lock: two concurrent runs (e.g. two deploy pipelines) would both see the
 * same migration as pending, and one would fail. A Postgres advisory lock serializes them: the second
 * run waits, then finds nothing pending.
 *
 * Advisory locks belong to a database session, so the lock is held on a dedicated single connection
 * (max: 1) that stays open while the migrator works on its own pool. If this process dies, Postgres
 * closes the session and releases the lock automatically.
 */
async function withMigrationLock<T>(work: () => Promise<T>): Promise<T> {
  const lockConnection = new SQL({ url: env.DATABASE_URL, max: 1 });
  try {
    const [{ acquired }] = await lockConnection`select pg_try_advisory_lock(hashtext('wagering:migrations')) as acquired`;
    if (!acquired) {
      console.log('another migration run holds the lock, waiting...');
      await lockConnection`select pg_advisory_lock(hashtext('wagering:migrations'))`;
    }
    return await work();
  } finally {
    await lockConnection`select pg_advisory_unlock(hashtext('wagering:migrations'))`.catch(() => {});
    await lockConnection.close();
  }
}

const orm = await MikroORM.init(buildOrmConfig(env, 'migrations'));

try {
  switch (command) {
    case 'up': {
      const applied = await withMigrationLock(() => orm.migrator.up());
      console.log(applied.length ? `applied: ${applied.map((m) => m.name).join(', ')}` : 'nothing to apply');
      break;
    }
    case 'down': {
      // Reverts exactly one migration per call, so a rollback is always a deliberate step.
      const reverted = await withMigrationLock(() => orm.migrator.down());
      console.log(reverted.length ? `reverted: ${reverted.map((m) => m.name).join(', ')}` : 'nothing to revert');
      break;
    }
    case 'status': {
      const executed = await orm.migrator.getExecuted();
      const pending = await orm.migrator.getPending();
      console.log({ executed: executed.map((m) => m.name), pending: pending.map((m) => m.name) });
      break;
    }
    default:
      console.error('usage: bun run scripts/migrate.ts <up|down|status>');
      process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
