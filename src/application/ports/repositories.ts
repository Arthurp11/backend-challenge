import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';

/*
 * Ports: what the use cases need from persistence, in domain terms. Implementations live in
 * infrastructure (MikroORM). Every call runs inside the SQL transaction opened by UnitOfWork.run.
 */

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT … FOR UPDATE: waits for any other transaction holding this wallet (per-wallet lock, never global). */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  /**
   * Writes balance, version and updatedAt, guarded by the version that was read (`expectedVersion`).
   * Throws ConcurrentModificationError if the row changed in the meantime (a lost update was prevented).
   */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
  /** Persists status-related fields of a non-terminal transaction (PENDING_REFERENCE retries). */
  update(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** True when a PROCESSED REFUND or ROLLBACK already points to this transaction. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** Entries in version order, starting after `afterVersion` (exclusive). */
  listByWallet(walletId: string, page: { afterVersion?: number; limit: number }): Promise<WalletLedgerEntry[]>;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
}

export interface InboxRepository {
  /**
   * Records the message unless (consumerName, messageId) already exists. Returns the existing record
   * on a duplicate, undefined when it was inserted now. Concurrent inserts of the same key serialize
   * on the primary key, so exactly one of them wins.
   */
  insertIfAbsent(message: InboxMessage): Promise<InboxMessage | undefined>;
}

export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}
