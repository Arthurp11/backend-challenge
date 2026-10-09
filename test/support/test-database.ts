import { MikroORM } from '@mikro-orm/postgresql';
import { type Env, loadEnv } from '../../src/infrastructure/config/env';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

/** Integration tests use their own database (`wagering_test`), so a reset never touches dev data. */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) {
    return process.env.TEST_DATABASE_URL;
  }
  const url = new URL(loadEnv().DATABASE_URL);
  url.pathname = '/wagering_test';
  return url.toString();
}

/** Background workers are off by default in tests: each test turns on exactly what it exercises. */
export const TEST_ENV_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  RUN_CONSUMER: 'false',
  RUN_OUTBOX_PUBLISHER: 'false',
  RUN_PENDING_REFERENCE_WORKER: 'false',
};

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({ ...process.env, ...TEST_ENV_DEFAULTS, DATABASE_URL: testDatabaseUrl(), ...overrides });
}

let ready: Promise<MikroORM> | undefined;

/**
 * Recreates the schema from the real migrations once per test run and shares one ORM between test
 * files. Tests isolate themselves with fresh uuidv7 ids instead of cleaning tables between tests.
 */
export function useTestDatabase(): Promise<MikroORM> {
  ready ??= recreateSchema();
  return ready;
}

/** Runs `up` or `down` on the test database with a dedicated migrator connection. */
export async function migrateTestDatabase(direction: 'up' | 'down'): Promise<string[]> {
  const migrator = await MikroORM.init(buildOrmConfig(testEnv(), 'migrations'));
  try {
    const result = direction === 'up' ? await migrator.migrator.up() : await migrator.migrator.down();
    return result.map((migration) => migration.name);
  } finally {
    await migrator.close(true);
  }
}

export async function closeTestDatabase(): Promise<void> {
  if (ready) {
    const orm = await ready;
    ready = undefined;
    await orm.close(true);
  }
}

async function recreateSchema(): Promise<MikroORM> {
  const env = testEnv();
  const database = new URL(env.DATABASE_URL).pathname.slice(1);
  if (!database.endsWith('_test')) {
    throw new Error(`refusing to reset "${database}": integration tests only run against a *_test database`);
  }
  const admin = await MikroORM.init(buildOrmConfig(env, 'migrations'));
  try {
    const connection = admin.em.getConnection();
    await connection.execute('drop schema if exists public cascade');
    await connection.execute('create schema public');
    await admin.migrator.up();
  } finally {
    await admin.close(true);
  }
  return MikroORM.init(buildOrmConfig(env));
}
