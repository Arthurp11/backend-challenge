import type { TransactionalRepositories } from './repositories';

export interface UnitOfWork {
  /**
   * Runs `work` in one SQL transaction (READ COMMITTED). Commits when it resolves and rolls back when it
   * throws, so wallet, ledger, inbox and outbox writes are all-or-nothing. Database errors come out
   * translated (see application/errors.ts), never as driver-specific exceptions.
   */
  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T>;
}
