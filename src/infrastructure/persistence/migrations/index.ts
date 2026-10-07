import type { MigrationObject } from '@mikro-orm/core';

/**
 * Migrations are registered explicitly (no filesystem glob discovery): the order is reviewable
 * in code and works the same under Bun, in Docker and in tests.
 * Every migration is hand-written SQL with a matching `down()`.
 */
export const migrations: MigrationObject[] = [];
