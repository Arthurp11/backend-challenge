import { DecimalType, EntitySchema } from '@mikro-orm/core';

/*
 * Persistence records: plain row shapes mapped with EntitySchema, so the domain classes stay free of
 * ORM decorators. Mappers (mappers.ts) convert records <-> domain objects via `rehydrate`.
 * Money columns are numeric(20,2) read as strings (DecimalType 'string'): a number never appears.
 */

const money = (fieldName: string, nullable = false) => ({ type: new DecimalType('string'), fieldName, nullable });
const timestamp = (fieldName: string, nullable = false) => ({ type: 'datetime', fieldName, nullable }) as const;

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balanceAmount: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string' },
    balanceAmount: money('balance_amount'),
    version: { type: 'integer' },
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
});

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  resultBalanceAmount: string | null;
  resultBalanceCurrency: string | null;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id', nullable: true },
    gameId: { type: 'string', fieldName: 'game_id', nullable: true },
    kind: { type: 'string' },
    amount: money('amount'),
    currency: { type: 'string' },
    referenceExternalTransactionId: { type: 'string', fieldName: 'reference_external_transaction_id', nullable: true },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    resultBalanceAmount: money('result_balance_amount', true),
    resultBalanceCurrency: { type: 'string', fieldName: 'result_balance_currency', nullable: true },
    referenceAttempts: { type: 'integer', fieldName: 'reference_attempts' },
    nextReferenceAttemptAt: timestamp('next_reference_attempt_at', true),
    createdAt: timestamp('created_at'),
    processedAt: timestamp('processed_at', true),
  },
});

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    amount: money('amount'),
    currency: { type: 'string' },
    balanceBefore: money('balance_before'),
    balanceAfter: money('balance_after'),
    walletVersion: { type: 'integer', fieldName: 'wallet_version' },
    createdAt: timestamp('created_at'),
  },
});

export interface InboxMessageRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', fieldName: 'consumer_name', primary: true },
    messageId: { type: 'string', fieldName: 'message_id', primary: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    receivedAt: timestamp('received_at'),
    processedAt: timestamp('processed_at', true),
  },
});

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
  lastError: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    payload: { type: 'json' },
    occurredAt: timestamp('occurred_at'),
    attempts: { type: 'integer' },
    nextAttemptAt: timestamp('next_attempt_at', true),
    publishedAt: timestamp('published_at', true),
    lastError: { type: 'string', fieldName: 'last_error', nullable: true },
  },
});

export const persistenceSchemas = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
