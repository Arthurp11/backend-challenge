import { afterAll } from 'bun:test';

// The logger reads LOG_LEVEL when first imported: keep test output readable.
process.env.LOG_LEVEL ??= 'silent';

const { closeTestDatabase } = await import('./test-database');
afterAll(closeTestDatabase);
