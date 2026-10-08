import type { LedgerDirection } from '../ledger/ledger-direction';
import type { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { MoneyProps } from '../money/money';
import type { FailureCode } from '../wagering/failure-code';
import { type WagerTransaction, type WagerTransactionKind, WagerTransactionStatus } from '../wagering/wager-transaction';
import type { Wallet } from '../wallet/wallet';
import { type EventContext, IntegrationEvent } from './integration-event';

/*
 * Every event uses the walletId as aggregateId: the wallet is the unit of consistency (§8), so
 * consumers can partition and order by it (WalletBalanceChanged also carries walletVersion).
 */

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  /** Balance observed when the transaction reached this status. */
  balance: MoneyProps;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceTransactionId: string | null;
  processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Any applied transaction, including LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed);
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.walletId,
      data: {
        ...baseData(transaction),
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        processedAt: required(transaction.processedAt, 'processedAt').toISOString(),
      },
    });
  }
}

/** Business rule violation (terminal). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected);
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.walletId,
      data: { ...baseData(transaction), failureCode: required(transaction.failureCode, 'failureCode') },
    });
  }
}

/** The referenced transaction has not arrived yet; the worker will retry. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, WagerTransactionStatus.PendingReference);
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.walletId,
      data: {
        ...baseData(transaction),
        referenceExternalTransactionId: required(transaction.referenceExternalTransactionId, 'referenceExternalTransactionId'),
        nextAttemptAt: required(transaction.nextReferenceAttemptAt, 'nextReferenceAttemptAt').toISOString(),
      },
    });
  }
}

/** Only when the balance actually changes (one per ledger entry). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new Error('ledger entry does not belong to this wallet');
    }
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}

function baseData(transaction: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    balance: required(transaction.resultBalance, 'resultBalance').toJSON(),
  };
}

function assertStatus(transaction: WagerTransaction, expected: WagerTransactionStatus): void {
  if (transaction.status !== expected) {
    throw new Error(`cannot build a ${expected} event from a ${transaction.status} transaction`);
  }
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) {
    throw new Error(`${field} is missing`);
  }
  return value;
}
