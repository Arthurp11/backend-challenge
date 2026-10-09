import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import type { Env } from '../config/env';
import { migrations } from './migrations';
import { persistenceSchemas } from './schemas';

/**
 * `purpose: 'migrations'` drops the lock and statement timeouts: they protect request latency, and a
 * schema change on a large table may legitimately take longer than a request should.
 */
export function buildOrmConfig(env: Env, purpose: 'app' | 'migrations' = 'app') {
  return defineConfig({
    clientUrl: env.DATABASE_URL,
    // Persistence records (EntitySchema) only; the domain classes stay free of ORM metadata.
    entities: persistenceSchemas,
    extensions: [Migrator],
    pool: { min: 0, max: env.DB_POOL_MAX },
    // Passed to the pg pool: applied as session settings on every connection.
    driverOptions: {
      connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
      ...(purpose === 'app' && {
        lock_timeout: env.DB_LOCK_TIMEOUT_MS,
        statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
        idle_in_transaction_session_timeout: env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      }),
    },
    migrations: {
      migrationsList: migrations,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      snapshotOnMigrate: false,
    },
    debug: false,
  });
}
