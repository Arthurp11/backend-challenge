import { LedgerDirection } from '../ledger/ledger-direction';
import type { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { BackoffPolicy } from '../shared/backoff-policy';
import type { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import {
  InvalidWagerTransactionError,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

/** What the caller found when looking up `(providerId, referenceExternalTransactionId)`. */
export type ReferenceResolution =
  | { kind: 'none' }
  | { kind: 'missing' }
  | { kind: 'found'; transaction: WagerTransaction; alreadyReversed: boolean };

export interface ApplyWagerTransactionInput {
  wallet: Wallet;
  /** PENDING (first arrival) or PENDING_REFERENCE (worker retry). */
  transaction: WagerTransaction;
  reference: ReferenceResolution;
  /** Id for the ledger entry, if one is created. */
  entryId: string;
  at: Date;
  referenceRetry: BackoffPolicy;
}

const ALLOWED_REFERENCES: Partial<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>> = {
  [WagerTransactionKind.Win]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Loss]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]),
};

/**
 * Applies the business rules of §7 to one transaction, mutating the wallet and the transaction.
 * Outcomes: PROCESSED (with a ledger entry when the balance moves), REJECTED with a failure code,
 * or PENDING_REFERENCE while the reference has not arrived. Pure domain: no I/O, no clock, no ids.
 */
export function applyWagerTransaction(input: ApplyWagerTransactionInput): { entry: WalletLedgerEntry | undefined } {
  const { wallet, transaction, reference, entryId, at, referenceRetry } = input;
  assertCallerContract(input);

  const walletProblem = checkWallet(transaction, wallet);
  if (walletProblem) {
    transaction.reject(walletProblem, at, wallet.balance);
    return { entry: undefined };
  }

  if (reference.kind === 'missing' || (reference.kind === 'found' && !reference.transaction.isTerminal())) {
    if (transaction.hasExhaustedReferenceAttempts(referenceRetry)) {
      transaction.reject(FailureCode.ReferenceNotFound, at, wallet.balance);
    } else {
      transaction.markPendingReference(at, wallet.balance, referenceRetry);
    }
    return { entry: undefined };
  }

  const referenced = reference.kind === 'found' ? reference.transaction : undefined;
  if (reference.kind === 'found') {
    const referenceProblem = checkReference(transaction, reference.transaction, reference.alreadyReversed);
    if (referenceProblem) {
      transaction.reject(referenceProblem, at, wallet.balance);
      return { entry: undefined };
    }
  }

  if (!transaction.affectsBalance()) {
    transaction.markProcessed(referenced?.id, at, wallet.balance);
    return { entry: undefined };
  }

  const movement = { money: transaction.money, transactionId: transaction.id, entryId, at };
  if (transaction.ledgerDirectionFor(referenced) === LedgerDirection.Debit) {
    if (!wallet.hasSufficientFunds(transaction.money)) {
      // A BET without balance and a reversal that would overdraw are operationally different (§7 rule 9).
      const code = transaction.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds;
      transaction.reject(code, at, wallet.balance);
      return { entry: undefined };
    }
    const entry = wallet.debit(movement);
    transaction.markProcessed(referenced?.id, at, wallet.balance);
    return { entry };
  }

  const entry = wallet.credit(movement);
  transaction.markProcessed(referenced?.id, at, wallet.balance);
  return { entry };
}

function checkWallet(transaction: WagerTransaction, wallet: Wallet): FailureCode | undefined {
  if (transaction.playerId !== wallet.playerId) return FailureCode.PlayerWalletMismatch;
  if (transaction.money.currency !== wallet.currency) return FailureCode.CurrencyMismatch;
  return undefined;
}

function checkReference(transaction: WagerTransaction, reference: WagerTransaction, alreadyReversed: boolean): FailureCode | undefined {
  if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;
  const sameContext =
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.money.currency === transaction.money.currency &&
    reference.roundId === transaction.roundId;
  if (!sameContext) return FailureCode.ReferenceMismatch;
  if (!ALLOWED_REFERENCES[transaction.kind]?.has(reference.kind)) return FailureCode.ReferenceKindNotAllowed;
  if (transaction.requiresReference()) {
    if (!reference.money.equals(transaction.money)) return FailureCode.ReferenceAmountMismatch;
    if (alreadyReversed) return FailureCode.AlreadyReversed;
  }
  return undefined;
}

/** Violations here are bugs in the caller, not business outcomes, so they throw. */
function assertCallerContract({ wallet, transaction, reference }: ApplyWagerTransactionInput): void {
  if (transaction.walletId !== wallet.id) {
    throw new InvalidWagerTransactionError('transaction does not belong to this wallet');
  }
  if (transaction.isTerminal()) {
    throw new InvalidWagerTransactionError(`transaction is already ${transaction.status}`);
  }
  if (transaction.hasReference() !== (reference.kind !== 'none')) {
    throw new InvalidWagerTransactionError('reference resolution does not match the transaction');
  }
}
