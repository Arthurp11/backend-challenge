import { AsyncLocalStorage } from 'node:async_hooks';
import { hostname } from 'node:os';
import pino from 'pino';

/** Ids that identify what a log line is about. Never amounts, balances or full payloads (§12). */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const context = new AsyncLocalStorage<LogContext>();

/**
 * Structured JSON logs. `mixin` stamps the current request/message context on every line (so deep code
 * logs without receiving ids as parameters) and `redact` masks financial fields even if logged by mistake.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'wagering', instanceId: process.env.INSTANCE_ID ?? `${hostname()}-${process.pid}` },
  mixin: () => ({ ...context.getStore() }),
  redact: {
    paths: ['payload', 'body', 'money', 'balance', 'amount', '*.payload', '*.body', '*.money', '*.balance', '*.amount'],
    censor: '[REDACTED]',
  },
});

/** Runs `work` with these ids attached to every log line written inside it (sync or async). */
export function withLogContext<T>(values: LogContext, work: () => T): T {
  return context.run({ ...context.getStore(), ...values }, work);
}

/** Adds ids learned mid-way (e.g. the transactionId once known) to the current context. */
export function addLogContext(values: LogContext): void {
  const store = context.getStore();
  if (store) {
    Object.assign(store, values);
  }
}
