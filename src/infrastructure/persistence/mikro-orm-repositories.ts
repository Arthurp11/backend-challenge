import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrentModificationError } from '../../application/errors';
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  TransactionalRepositories,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/repositories';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import { inboxMapper, ledgerMapper, outboxMapper, transactionMapper, walletMapper } from './mappers';
import { InboxMessageSchema, LedgerEntrySchema, OutboxMessageSchema, WagerTransactionSchema, WalletSchema } from './schemas';

/*
 * Every statement here runs immediately (insert, nativeUpdate, find), in the order the use case calls
 * it. Nothing is left for an implicit flush, and reads skip the identity map: records are mapped to
 * domain objects and never tracked, so the money path has no hidden writes.
 */
const READ = { disableIdentityMap: true } as const;

export function createRepositories(em: EntityManager): TransactionalRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
  };
}

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, walletMapper.toRecord(wallet));
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, READ);
    return record ? walletMapper.toDomain(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, { ...READ, lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? walletMapper.toDomain(record) : undefined;
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const { balanceAmount, version, updatedAt } = walletMapper.toRecord(wallet);
    const updated = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balanceAmount, version, updatedAt },
    );
    if (updated !== 1) {
      throw new ConcurrentModificationError('wallet', wallet.id);
    }
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, transactionMapper.toRecord(transaction));
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const updated = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id },
      transactionMapper.toStatusFields(transaction),
    );
    if (updated !== 1) {
      throw new ConcurrentModificationError('wager transaction', transaction.id);
    }
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ idempotencyKey });
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      status: 'PROCESSED',
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>> {
    const records = await this.em.find(
      WagerTransactionSchema,
      { status: 'PENDING_REFERENCE', nextReferenceAttemptAt: { $lte: now } },
      { ...READ, fields: ['id', 'walletId'], orderBy: { nextReferenceAttemptAt: 'asc' }, limit },
    );
    return records.map(({ id, walletId }) => ({ id, walletId }));
  }

  private async findOne(where: Partial<Record<'id' | 'idempotencyKey' | 'providerId' | 'externalTransactionId', string>>) {
    const record = await this.em.findOne(WagerTransactionSchema, where, READ);
    return record ? transactionMapper.toDomain(record) : undefined;
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, ledgerMapper.toRecord(entry));
  }

  async listByWallet(walletId: string, page: { afterVersion?: number; limit: number }): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntrySchema,
      page.afterVersion === undefined ? { walletId } : { walletId, walletVersion: { $gt: page.afterVersion } },
      { ...READ, orderBy: { walletVersion: 'asc' }, limit: page.limit },
    );
    return records.map(ledgerMapper.toDomain);
  }

  async listAllByWallet(walletId: string): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(LedgerEntrySchema, { walletId }, { ...READ, orderBy: { walletVersion: 'asc' } });
    return records.map(ledgerMapper.toDomain);
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length > 0) {
      await this.em.insertMany(OutboxMessageSchema, messages.map(outboxMapper.toRecord));
    }
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageSchema,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      { ...READ, orderBy: { id: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return records.map(outboxMapper.toDomain);
  }

  async save(message: OutboxMessage, lastError?: string): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
        lastError: lastError ?? null,
      },
    );
  }

  async backlog(): Promise<{ pending: number; oldestOccurredAt: Date | undefined }> {
    const [row] = await this.em.execute<Array<{ pending: number; oldest: string | null }>>(
      'select count(*)::int as pending, min(occurred_at) as oldest from outbox_messages where published_at is null',
    );
    return { pending: row?.pending ?? 0, oldestOccurredAt: row?.oldest ? new Date(row.oldest) : undefined };
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(message: InboxMessage): Promise<InboxMessage | undefined> {
    const result = await this.em
      .createQueryBuilder(InboxMessageSchema)
      .insert(inboxMapper.toRecord(message))
      .onConflict(['consumerName', 'messageId'])
      .ignore()
      .execute('run');
    if (result.affectedRows === 1) {
      return undefined;
    }
    const existing = await this.em.findOneOrFail(
      InboxMessageSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      READ,
    );
    return inboxMapper.toDomain(existing);
  }
}
