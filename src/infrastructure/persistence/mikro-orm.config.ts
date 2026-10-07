import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import type { Env } from '../config/env';
import { migrations } from './migrations';

export function buildOrmConfig(env: Env) {
  return defineConfig({
    clientUrl: env.DATABASE_URL,
    // Persistence schemas (EntitySchema) are registered here as they are written; the domain stays ORM-free.
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    pool: { min: 0, max: env.DB_POOL_MAX },
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
