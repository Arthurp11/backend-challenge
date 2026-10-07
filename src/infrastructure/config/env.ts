import { hostname } from 'node:os';
import { z } from 'zod';

/**
 * Single source of runtime configuration. Validated at boot so a bad deploy fails fast
 * instead of failing on the first financial transaction.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Hostname first: inside containers every replica runs as PID 1, so the PID alone is not unique.
  INSTANCE_ID: z.string().default(() => `${hostname()}-${process.pid}`),

  DATABASE_URL: z.string().default('postgres://wagering:wagering@localhost:5433/wagering'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().default('http://localhost:4566'),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),

  SQS_WAGER_QUEUE: z.string().default('wager-transactions.fifo'),
  SQS_WAGER_DLQ: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().default('wagering-events.fifo'),
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().positive().default(5),
  SQS_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source);
}
