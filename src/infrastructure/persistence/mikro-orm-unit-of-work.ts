import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { TransactionalRepositories } from '../../application/ports/repositories';
import type { UnitOfWork } from '../../application/ports/unit-of-work';
import { translateDatabaseError } from './database-errors';
import { createRepositories } from './mikro-orm-repositories';

/**
 * One SQL transaction per call, on a fresh EntityManager fork: workers and consumers have no request
 * context, and forks never share an identity map across concurrent units of work.
 * READ COMMITTED on purpose: after waiting for a wallet row lock, each statement sees what the
 * previous holder committed (the idempotency re-check depends on it).
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional((em) => work(createRepositories(em)), {
        isolationLevel: IsolationLevel.READ_COMMITTED,
      });
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
