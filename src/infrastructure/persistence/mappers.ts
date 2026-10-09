import type { LedgerDirection } from '../../domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './schemas';

/*
 * Records <-> domain. Reading always goes through `rehydrate` (no revalidation); enum columns are
 * trusted because the schema CHECKs already restrict their values. undefined <-> NULL happens here.
 */

const money = (amount: string, currency: string) => Money.from({ amount, currency });
const amountOf = (value: Money) => value.toJSON().amount;

export const walletMapper = {
  toRecord(wallet: Wallet): WalletRecord {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balanceAmount: amountOf(wallet.balance),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  },

  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: money(record.balanceAmount, record.currency),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },
};

export const transactionMapper = {
  toRecord(transaction: WagerTransaction): WagerTransactionRecord {
    return {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId ?? null,
      gameId: transaction.gameId ?? null,
      kind: transaction.kind,
      amount: amountOf(transaction.money),
      currency: transaction.money.currency,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      createdAt: transaction.createdAt,
      ...transactionMapper.toStatusFields(transaction),
    };
  },

  /** The mutable part of a transaction: what an UPDATE may change while it is not terminal. */
  toStatusFields(transaction: WagerTransaction) {
    return {
      status: transaction.status,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      failureCode: transaction.failureCode ?? null,
      resultBalanceAmount: transaction.resultBalance ? amountOf(transaction.resultBalance) : null,
      resultBalanceCurrency: transaction.resultBalance?.currency ?? null,
      referenceAttempts: transaction.referenceAttempts,
      nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
      processedAt: transaction.processedAt ?? null,
    };
  },

  toDomain(record: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId ?? undefined,
      gameId: record.gameId ?? undefined,
      kind: record.kind as WagerTransactionKind,
      money: money(record.amount, record.currency),
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      createdAt: record.createdAt,
      status: record.status as WagerTransactionStatus,
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
      processedAt: record.processedAt ?? undefined,
      resultBalance:
        record.resultBalanceAmount !== null && record.resultBalanceCurrency !== null
          ? money(record.resultBalanceAmount, record.resultBalanceCurrency)
          : undefined,
      referenceAttempts: record.referenceAttempts,
      nextReferenceAttemptAt: record.nextReferenceAttemptAt ?? undefined,
    });
  },
};

export const ledgerMapper = {
  toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: amountOf(entry.money),
      currency: entry.money.currency,
      balanceBefore: amountOf(entry.balanceBefore),
      balanceAfter: amountOf(entry.balanceAfter),
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    };
  },

  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: record.direction as LedgerDirection,
      money: money(record.amount, record.currency),
      balanceBefore: money(record.balanceBefore, record.currency),
      balanceAfter: money(record.balanceAfter, record.currency),
      walletVersion: record.walletVersion,
      createdAt: record.createdAt,
    });
  },
};

export const inboxMapper = {
  toRecord(message: InboxMessage): InboxMessageRecord {
    return {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    };
  },

  toDomain(record: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({ ...record, processedAt: record.processedAt ?? undefined });
  },
};

export const outboxMapper = {
  toRecord(message: OutboxMessage): OutboxMessageRecord {
    return {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? null,
      publishedAt: message.publishedAt ?? null,
      lastError: null,
    };
  },

  toDomain(record: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt ?? undefined,
      publishedAt: record.publishedAt ?? undefined,
    });
  },
};
