import { InboxMessage } from '../../domain/messaging/inbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import type { BackoffPolicy } from '../../domain/shared/backoff-policy';
import { applyWagerTransaction } from '../../domain/wagering/apply-wager-transaction';
import { WagerTransaction, type WagerTransactionKind } from '../../domain/wagering/wager-transaction';
import {
  ExternalIdConflictError,
  IdempotencyConflictError,
  InboxPayloadConflictError,
  TransientInfrastructureError,
  UniqueViolationError,
  WalletNotFoundError,
} from '../errors';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { TransactionalRepositories } from '../ports/repositories';
import type { UnitOfWork } from '../ports/unit-of-work';
import { resolveReference } from './reference-resolution';
import { outboxMessagesFor, toResult, type WagerTransactionResult } from './wager-outcome';

export interface WagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
  /** Present when the command came from the queue: recorded in the inbox inside the same SQL transaction. */
  message?: { consumerName: string; messageId: string } | undefined;
}

export interface ProcessWagerTransactionOptions {
  referenceRetry: BackoffPolicy;
  /** Bounded retries of transient failures (lock timeout, deadlock, connection) before giving up. */
  transientRetries: number;
  /** Observability hook, called before each in-process retry of a transient failure. */
  onTransientRetry?: (error: TransientInfrastructureError) => void;
}

/**
 * The single entry point for provider transactions: HTTP and SQS both call `execute`.
 *
 * Inside one SQL transaction (READ COMMITTED):
 *   inbox (queue only) → idempotency lookup → lock the wallet (SELECT … FOR UPDATE) → idempotency
 *   re-check → resolve the reference → domain rules → insert transaction → ledger entry → balance
 *   (UPDATE … WHERE version = read version) → outbox events → commit.
 *
 * The wallet row lock is the unit of concurrency: operations on one wallet run one at a time, different
 * wallets run in parallel, and the re-check after the lock sees whatever the previous holder committed.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: ProcessWagerTransactionOptions,
  ) {}

  async execute(command: WagerTransactionCommand): Promise<WagerTransactionResult> {
    let racedOnUniqueKey = false;
    let transientFailures = 0;
    for (;;) {
      // Rebuilt on every attempt: a failed attempt may have moved the previous instance's state.
      const transaction = this.build(command);
      try {
        return await this.uow.run((repositories) => this.process(repositories, transaction, command));
      } catch (error) {
        if (error instanceof UniqueViolationError && !racedOnUniqueKey) {
          // Another instance committed the same key (or external id) first. The re-run takes the
          // replay or conflict path, because the committed row is now visible.
          racedOnUniqueKey = true;
          continue;
        }
        if (error instanceof TransientInfrastructureError && transientFailures < this.options.transientRetries) {
          transientFailures += 1;
          this.options.onTransientRetry?.(error);
          await sleep(25 * 2 ** transientFailures + Math.floor(Math.random() * 25));
          continue;
        }
        throw error;
      }
    }
  }

  private build(command: WagerTransactionCommand): WagerTransaction {
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });
  }

  private async process(
    repositories: TransactionalRepositories,
    transaction: WagerTransaction,
    command: WagerTransactionCommand,
  ): Promise<WagerTransactionResult> {
    const { wallets, transactions, ledger, outbox, inbox } = repositories;
    const now = this.clock.now();

    if (command.message) {
      const received = InboxMessage.receive({ ...command.message, payloadHash: transaction.payloadHash, receivedAt: now });
      received.markProcessed(now);
      const alreadyReceived = await inbox.insertIfAbsent(received);
      if (alreadyReceived) {
        return this.replayDelivery(repositories, transaction, alreadyReceived.matchesPayload(transaction.payloadHash), command);
      }
    }

    // Fast path: a replay needs no lock at all.
    const existing = await transactions.findByIdempotencyKey(transaction.idempotencyKey);
    if (existing) {
      return this.replay(existing, transaction);
    }

    const wallet = await wallets.findByIdForUpdate(transaction.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(transaction.walletId);
    }

    // While we waited for the lock, a duplicate may have committed: READ COMMITTED lets us see it now.
    const committedMeanwhile = await transactions.findByIdempotencyKey(transaction.idempotencyKey);
    if (committedMeanwhile) {
      return this.replay(committedMeanwhile, transaction);
    }
    if (await transactions.findByExternalId(transaction.providerId, transaction.externalTransactionId)) {
      throw new ExternalIdConflictError(transaction.providerId, transaction.externalTransactionId);
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

    await transactions.insert(transaction);
    if (entry) {
      await ledger.insert(entry);
      await wallets.saveBalance(wallet, expectedVersion);
    }
    await outbox.enqueue(
      outboxMessagesFor(transaction, wallet, entry, () => ({
        eventId: this.ids.next(),
        correlationId: command.correlationId,
        causationId: command.message?.messageId,
        occurredAt: now,
      })),
    );
    return toResult(transaction, false);
  }

  private replay(existing: WagerTransaction, candidate: WagerTransaction): WagerTransactionResult {
    if (!existing.matchesPayload(candidate.payloadHash)) {
      throw new IdempotencyConflictError(candidate.idempotencyKey);
    }
    return toResult(existing, true);
  }

  /** A redelivered queue message: same payload is a replay, a different payload is a poison message. */
  private async replayDelivery(
    { transactions }: TransactionalRepositories,
    transaction: WagerTransaction,
    samePayload: boolean,
    command: WagerTransactionCommand,
  ): Promise<WagerTransactionResult> {
    const messageId = command.message?.messageId ?? '';
    const existing =
      (await transactions.findByIdempotencyKey(transaction.idempotencyKey)) ??
      (await transactions.findByExternalId(transaction.providerId, transaction.externalTransactionId));
    if (!samePayload || !existing) {
      throw new InboxPayloadConflictError(messageId);
    }
    return this.replay(existing, transaction);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
