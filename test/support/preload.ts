import { afterAll } from 'bun:test';
import { closeTestDatabase } from './test-database';

afterAll(closeTestDatabase);
