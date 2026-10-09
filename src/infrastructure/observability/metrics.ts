import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

/** Prometheus metrics (§12), exposed at GET /metrics. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const metrics = {
  transactions: new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions by resulting status, kind and entry point (replays go to wager_duplicates_detected_total)',
    labelNames: ['status', 'kind', 'source'] as const,
    registers: [registry],
  }),
  duplicates: new Counter({
    name: 'wager_duplicates_detected_total',
    help: 'Requests or messages answered as idempotent replays (no new effect)',
    labelNames: ['source'] as const,
    registers: [registry],
  }),
  conflicts: new Counter({
    name: 'wager_conflicts_total',
    help: 'Idempotency and inbox payload conflicts',
    labelNames: ['code'] as const,
    registers: [registry],
  }),
  retries: new Counter({
    name: 'wager_retries_total',
    help: 'Retries of transient failures (in-process and queue redeliveries)',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),
  lockConflicts: new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks and lost-update guards that fired',
    registers: [registry],
  }),
  deadLetters: new Counter({
    name: 'wager_dead_letter_messages_total',
    help: 'Messages sent to the DLQ by reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),
  processingSeconds: new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latency of processing one wager transaction',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),
  outboxPublished: new Counter({
    name: 'outbox_published_total',
    help: 'Outbox messages published',
    registers: [registry],
  }),
  outboxPublishFailures: new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Failed publish attempts (rescheduled with backoff)',
    registers: [registry],
  }),
  outboxPending: new Gauge({
    name: 'outbox_pending_messages',
    help: 'Unpublished outbox messages',
    registers: [registry],
  }),
  outboxLagSeconds: new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [registry],
  }),
  pendingReferenceResolutions: new Counter({
    name: 'pending_reference_resolutions_total',
    help: 'PENDING_REFERENCE transactions resolved by the worker, by final status',
    labelNames: ['status'] as const,
    registers: [registry],
  }),
  reconciliationDivergences: new Counter({
    name: 'reconciliation_divergences_total',
    help: 'Reconciliations where the stored balance did not match the ledger',
    registers: [registry],
  }),
};
