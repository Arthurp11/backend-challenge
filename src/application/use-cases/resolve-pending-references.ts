import type { BackoffPolicy } from '../../domain/shared/backoff-policy';
import { applyWagerTransaction } from '../../domain/wagering/apply-wager-transaction';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { UnitOfWork } from '../ports/unit-of-work';
import { resolveReference } from './reference-resolution';
import { outboxMessagesFor } from './wager-outcome';

export interface ResolvePendingReferencesOptions {
  referenceRetry: BackoffPolicy;
  batchSize: number;
}

/**
 * Scheduled retry of PENDING_REFERENCE transactions (§7.1). Each candidate is retried in its own SQL
 * transaction with the same rules as the first arrival: lock the wallet, re-read the transaction, apply.
 *
 * Safe with many workers on many instances: the wallet lock serializes them, and the re-read after
 * the lock skips a transaction another worker already resolved or rescheduled.
 */
export class ResolvePendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: ResolvePendingReferencesOptions,
  ) {}

  /** `examined` equal to the batch size means "call again right away"; `resolved` lists final statuses. */
  async runOnce(): Promise<{ examined: number; resolved: WagerTransactionStatus[] }> {
    const due = await this.uow.run(({ transactions }) => transactions.findDuePendingReferences(this.clock.now(), this.options.batchSize));
    const resolved: WagerTransactionStatus[] = [];
    for (const candidate of due) {
      const status = await this.retry(candidate.id, candidate.walletId);
      if (status && status !== WagerTransactionStatus.PendingReference) {
        resolved.push(status);
      }
    }
    return { examined: due.length, resolved };
  }

  private async retry(transactionId: string, walletId: string): Promise<WagerTransactionStatus | undefined> {
    return this.uow.run(async ({ wallets, transactions, ledger, outbox }) => {
      const now = this.clock.now();
      // Same lock order as the request path (wallet first): no deadlock between workers and requests.
      const wallet = await wallets.findByIdForUpdate(walletId);
      const transaction = await transactions.findById(transactionId);
      const stillDue =
        transaction?.status === WagerTransactionStatus.PendingReference &&
        (transaction.nextReferenceAttemptAt?.getTime() ?? 0) <= now.getTime();
      if (!wallet || !transaction || !stillDue) {
        return undefined;
      }

      const expectedVersion = wallet.version;
      const { entry } = applyWagerTransaction({
        wallet,
        transaction,
        reference: await resolveReference(transactions, transaction),
        entryId: this.ids.next(),
        at: now,
        referenceRetry: this.options.referenceRetry,
      });

      await transactions.update(transaction);
      if (entry) {
        await ledger.insert(entry);
        await wallets.saveBalance(wallet, expectedVersion);
      }
      // Waiting again is not news (the PendingReference event was published on arrival); resolutions are.
      if (transaction.status !== WagerTransactionStatus.PendingReference) {
        await outbox.enqueue(
          outboxMessagesFor(transaction, wallet, entry, () => ({
            eventId: this.ids.next(),
            correlationId: transaction.id,
            occurredAt: now,
          })),
        );
      }
      return transaction.status;
    });
  }
}
