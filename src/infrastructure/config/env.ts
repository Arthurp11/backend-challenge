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
  // A request never waits forever on a hot wallet: past the lock timeout it fails as transient (retryable).
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  // Kills sessions that hold locks while idle inside a transaction (e.g. a crashed request handler).
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),

  // Out-of-order references: 1s, 2s, 4s… capped at 60s, 10 waits (about 6 minutes) before REFERENCE_NOT_FOUND.
  REFERENCE_RETRY_BASE_MS: z.coerce.number().int().positive().default(1_000),
  REFERENCE_RETRY_MAX_MS: z.coerce.number().int().positive().default(60_000),
  REFERENCE_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  // In-process retries of transient failures (lock timeout, deadlock, connection) before answering 503.
  TRANSIENT_RETRIES: z.coerce.number().int().min(0).default(2),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().default('http://localhost:4566'),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),

  SQS_WAGER_QUEUE: z.string().default('wager-transactions.fifo'),
  SQS_WAGER_DLQ: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().default('wagering-events.fifo'),
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().positive().default(5),
  SQS_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_MAX_MESSAGES: z.coerce.number().int().min(1).max(10).default(10),
  CONSUMER_NAME: z.string().default('wagering-service'),

  // Every instance runs every role by default; flags let tests (or a deployment) split them.
  RUN_CONSUMER: z.stringbool().default(true),
  RUN_OUTBOX_PUBLISHER: z.stringbool().default(true),
  RUN_PENDING_REFERENCE_WORKER: z.stringbool().default(true),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(200),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  OUTBOX_RETRY_BASE_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_RETRY_MAX_MS: z.coerce.number().int().positive().default(30_000),
  PENDING_REFERENCE_POLL_MS: z.coerce.number().int().positive().default(500),
  PENDING_REFERENCE_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(10_000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Test seam for crash scenarios (§13). Never set in production.
  FAULT_INJECTION: z.enum(['none', 'crash_after_commit_before_ack', 'crash_after_publish_before_mark']).default('none'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source);
}
