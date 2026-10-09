import { describe, expect, it } from 'bun:test';
import { TransientInfrastructureError } from '../../../src/application/errors';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { ResolvePendingReferences } from '../../../src/application/use-cases/resolve-pending-references';
import { referenceRetry } from '../../support/domain-builders';

describe('ResolvePendingReferences', () => {
  it('a candidate that fails (hot wallet past its lock timeout) does not stall the others', async () => {
    const lockAttempts: string[] = [];
    const repos = {
      transactions: {
        findDuePendingReferences: async () => [
          { id: 'tx-hot', walletId: 'hot-wallet' },
          { id: 'tx-calm', walletId: 'calm-wallet' },
        ],
        findById: async () => undefined,
      },
      wallets: {
        findByIdForUpdate: async (walletId: string) => {
          lockAttempts.push(walletId);
          if (walletId === 'hot-wallet') throw new TransientInfrastructureError('lock timeout');
          return undefined;
        },
      },
    };
    const uow = { run: (work: (r: typeof repos) => Promise<unknown>) => work(repos) } as unknown as UnitOfWork;
    const worker = new ResolvePendingReferences(uow, { now: () => new Date() }, { next: () => 'id' }, { referenceRetry, batchSize: 50 });

    const result = await worker.runOnce();

    expect(lockAttempts).toEqual(['hot-wallet', 'calm-wallet']);
    expect(result.examined).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toBeInstanceOf(TransientInfrastructureError);
  });
});
