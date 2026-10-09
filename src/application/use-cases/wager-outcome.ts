import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wagering-events';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { MoneyProps } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';

/** What a provider gets back, from the first call or from any replay of it. */
export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Balance observed when the transaction reached this status (never the current balance). */
  balance: MoneyProps | null;
  failureCode: FailureCode | null;
  idempotentReplay: boolean;
}

export function toResult(transaction: WagerTransaction, idempotentReplay: boolean): WagerTransactionResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.resultBalance?.toJSON() ?? null,
    failureCode: transaction.failureCode ?? null,
    idempotentReplay,
  };
}

/**
 * Integration events for the state a transaction just reached. WalletBalanceChanged only when the
 * balance actually moved (there is a ledger entry). Enqueued in the same SQL transaction.
 */
export function outboxMessagesFor(
  transaction: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  context: () => EventContext,
): OutboxMessage[] {
  const events: IntegrationEvent<unknown>[] = [];
  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      if (entry) {
        events.push(WalletBalanceChanged.from(wallet, entry, context()));
      }
      events.push(WagerTransactionProcessed.from(transaction, context()));
      break;
    case WagerTransactionStatus.Rejected:
      events.push(WagerTransactionRejected.from(transaction, context()));
      break;
    case WagerTransactionStatus.PendingReference:
      events.push(WagerTransactionPendingReference.from(transaction, context()));
      break;
    default:
      break;
  }
  return events.map((event) => OutboxMessage.enqueue(event));
}
