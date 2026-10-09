import type { ReferenceResolution } from '../../domain/wagering/apply-wager-transaction';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WagerTransactionRepository } from '../ports/repositories';

/**
 * Looks the reference up by (providerId, referenceExternalTransactionId) and tells the domain whether it
 * was already reversed. Called while the wallet lock is held, so no other reversal can commit meanwhile.
 */
export async function resolveReference(
  transactions: WagerTransactionRepository,
  transaction: WagerTransaction,
): Promise<ReferenceResolution> {
  if (!transaction.referenceExternalTransactionId) {
    return { kind: 'none' };
  }
  const reference = await transactions.findByExternalId(transaction.providerId, transaction.referenceExternalTransactionId);
  if (!reference) {
    return { kind: 'missing' };
  }
  const alreadyReversed = transaction.requiresReference() && (await transactions.hasProcessedReversal(reference.id));
  return { kind: 'found', transaction: reference, alreadyReversed };
}
