import type { TransactionalRepositories } from './repositories';

export interface UnitOfWorkOptions {
  /**
   * Read-only REPEATABLE READ transaction: every statement sees the same snapshot. Used by reads that
   * must compare several tables consistently (reconciliation) without locking writers out.
   */
  snapshot?: boolean;
}

export interface UnitOfWork {
  /**
   * Runs `work` in one SQL transaction (READ COMMITTED by default). Commits when it resolves and rolls
   * back when it throws, so wallet, ledger, inbox and outbox writes are all-or-nothing. Database errors
   * come out translated (see application/errors.ts), never as driver-specific exceptions.
   */
  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
