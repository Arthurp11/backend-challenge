import { beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { ConcurrentModificationError, TransientInfrastructureError, UniqueViolationError } from '../../src/application/errors';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../src/domain/events/wagering-events';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { Money } from '../../src/domain/money/money';
import { BackoffPolicy } from '../../src/domain/shared/backoff-policy';
import { applyWagerTransaction } from '../../src/domain/wagering/apply-wager-transaction';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { assertLedgerInvariant } from '../support/ledger-invariant';
import { testEnv, useTestDatabase } from '../support/test-database';

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
beforeAll(async () => {
  orm = await useTestDatabase();
  uow = new MikroOrmUnitOfWork(orm);
});

const uuid = () => Bun.randomUUIDv7();
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const retry = BackoffPolicy.exponential({ baseDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 3 });

/** Opens and persists a wallet the way CreateWallet will: wallet, OPENING transaction, entry and event together. */
async function persistedWallet(initialBalance = '100.00') {
  const at = new Date();
  const opening = WagerTransaction.opening({ id: uuid(), walletId: uuid(), playerId: uuid(), money: brl(initialBalance), createdAt: at });
  const { wallet, openingEntry } = Wallet.open({
    id: opening.walletId,
    playerId: opening.playerId,
    initialBalance: brl(initialBalance),
    opening: { transactionId: opening.id, entryId: uuid() },
    at,
  });
  opening.markProcessed(undefined, at, wallet.balance);
  await uow.run(async (repos) => {
    await repos.wallets.insert(wallet);
    await repos.transactions.insert(opening);
    if (openingEntry) {
      await repos.ledger.insert(openingEntry);
      await repos.outbox.enqueue([
        OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, { eventId: uuid(), correlationId: uuid(), occurredAt: at })),
      ]);
    }
  });
  return wallet;
}

function bet(wallet: Wallet, amount = '25.00', overrides: { kind?: WagerTransactionKind; reference?: string } = {}) {
  const externalTransactionId = uuid();
  return WagerTransaction.create({
    id: uuid(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: overrides.kind ?? WagerTransactionKind.Bet,
    money: brl(amount),
    referenceExternalTransactionId: overrides.reference,
    createdAt: new Date(),
  });
}

/** Applies a BET inside one unit of work: lock, rules, transaction, entry, balance and event. */
async function placeBet(walletId: string, amount: string) {
  return uow.run(async (repos) => {
    const wallet = (await repos.wallets.findByIdForUpdate(walletId))!;
    const expectedVersion = wallet.version;
    const transaction = bet(wallet, amount);
    const { entry } = applyWagerTransaction({ wallet, transaction, reference: { kind: 'none' }, entryId: uuid(), at: new Date(), referenceRetry: retry });
    await repos.transactions.insert(transaction);
    if (entry) {
      await repos.ledger.insert(entry);
      await repos.wallets.saveBalance(wallet, expectedVersion);
    }
    return transaction;
  });
}

describe('persistence (real PostgreSQL)', () => {
  it('round-trips a wallet opened with its OPENING entry, keeping balance and ledger consistent', async () => {
    const wallet = await persistedWallet('100.00');

    const loaded = await uow.run((repos) => repos.wallets.findById(wallet.id));
    const ledger = await uow.run((repos) => repos.ledger.listByWallet(wallet.id, { limit: 10 }));

    expect(loaded?.balance.equals(brl('100.00'))).toBe(true);
    expect(loaded?.version).toBe(1);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.isBalanced()).toBe(true);
    await assertLedgerInvariant(orm, wallet.id);
  });

  it('applies a BET end to end and keeps the invariant', async () => {
    const wallet = await persistedWallet('100.00');

    const transaction = await placeBet(wallet.id, '30.00');

    const stored = await uow.run((repos) => repos.transactions.findByIdempotencyKey(transaction.idempotencyKey));
    expect(stored?.status).toBe(WagerTransactionStatus.Processed);
    expect(stored?.resultBalance?.equals(brl('70.00'))).toBe(true);
    expect(stored?.payloadHash).toBe(transaction.payloadHash);
    await assertLedgerInvariant(orm, wallet.id);
  });

  it('is atomic: if anything fails, nothing of the unit of work is committed (wallet, ledger, inbox, outbox)', async () => {
    const wallet = await persistedWallet('100.00');
    const at = new Date();
    const messageId = uuid();
    let transactionId = '';
    let eventId = '';

    const failing = uow.run(async (repos) => {
      await repos.inbox.insertIfAbsent(InboxMessage.receive({ messageId, consumerName: 'wager-consumer', payloadHash: 'abc', receivedAt: at }));
      const locked = (await repos.wallets.findByIdForUpdate(wallet.id))!;
      const transaction = bet(locked, '10.00');
      transactionId = transaction.id;
      const { entry } = applyWagerTransaction({ wallet: locked, transaction, reference: { kind: 'none' }, entryId: uuid(), at, referenceRetry: retry });
      await repos.transactions.insert(transaction);
      await repos.ledger.insert(entry!);
      await repos.wallets.saveBalance(locked, 1);
      const event = WagerTransactionProcessed.from(transaction, { eventId: uuid(), correlationId: uuid(), occurredAt: at });
      eventId = event.eventId;
      await repos.outbox.enqueue([OutboxMessage.enqueue(event)]);
      throw new Error('crash before commit');
    });

    await expect(failing).rejects.toThrow('crash before commit');
    const after = await uow.run((repos) => repos.wallets.findById(wallet.id));
    expect(after?.balance.equals(brl('100.00'))).toBe(true);
    const count = async (table: string, column: string, id: string) =>
      ((await orm.em.fork().getConnection().execute(`select count(*)::int as n from ${table} where ${column} = ?`, [id])) as Array<{ n: number }>)[0]?.n;
    expect(await count('wager_transactions', 'id', transactionId)).toBe(0);
    expect(await count('wallet_ledger_entries', 'transaction_id', transactionId)).toBe(0);
    expect(await count('inbox_messages', 'message_id', messageId)).toBe(0);
    expect(await count('outbox_messages', 'id', eventId)).toBe(0);
    await assertLedgerInvariant(orm, wallet.id);
  });

  it('refuses a lost update: saving with a stale version throws and rolls back', async () => {
    const wallet = await persistedWallet('100.00');
    await placeBet(wallet.id, '10.00');

    const stale = uow.run(async (repos) => {
      const current = (await repos.wallets.findById(wallet.id))!;
      const transaction = bet(current, '5.00');
      const { entry } = applyWagerTransaction({ wallet: current, transaction, reference: { kind: 'none' }, entryId: uuid(), at: new Date(), referenceRetry: retry });
      await repos.transactions.insert(transaction);
      await repos.ledger.insert(entry!);
      await repos.wallets.saveBalance(current, 1); // read at version 2, claims version 1
    });

    await expect(stale).rejects.toBeInstanceOf(ConcurrentModificationError);
    await assertLedgerInvariant(orm, wallet.id);
  });

  it('the wallet lock serializes writers: the second waits until the first commits', async () => {
    const wallet = await persistedWallet('100.00');
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstHoldsLock = new Promise<void>((resolve) => (releaseFirst = resolve));

    const first = uow.run(async (repos) => {
      await repos.wallets.findByIdForUpdate(wallet.id);
      order.push('first locked');
      await firstHoldsLock;
      order.push('first commits');
    });
    await Bun.sleep(50);
    const second = uow.run(async (repos) => {
      await repos.wallets.findByIdForUpdate(wallet.id);
      order.push('second locked');
    });
    await Bun.sleep(100);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['first locked', 'first commits', 'second locked']);
  });

  it('a lock held past lock_timeout surfaces as a transient (retryable) error', async () => {
    const wallet = await persistedWallet('100.00');
    const impatient = await MikroORM.init(buildOrmConfig(testEnv({ DB_LOCK_TIMEOUT_MS: '100' })));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    try {
      const holder = uow.run(async (repos) => {
        await repos.wallets.findByIdForUpdate(wallet.id);
        await held;
      });
      await Bun.sleep(50);

      const waiter = new MikroOrmUnitOfWork(impatient).run((repos) => repos.wallets.findByIdForUpdate(wallet.id));

      await expect(waiter).rejects.toBeInstanceOf(TransientInfrastructureError);
      release();
      await holder;
    } finally {
      release();
      await impatient.close(true);
    }
  });

  it('translates a duplicate idempotency key into UniqueViolationError with the constraint name', async () => {
    const wallet = await persistedWallet('100.00');
    const first = await placeBet(wallet.id, '1.00');
    const duplicate = WagerTransaction.create({
      id: uuid(),
      providerId: 'provider-a',
      externalTransactionId: uuid(),
      idempotencyKey: first.idempotencyKey,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: brl('1.00'),
      referenceExternalTransactionId: undefined,
      createdAt: new Date(),
    });
    duplicate.reject(FailureCode.InsufficientFunds, new Date(), brl('99.00'));

    const attempt = uow.run((repos) => repos.transactions.insert(duplicate));

    await expect(attempt).rejects.toBeInstanceOf(UniqueViolationError);
    await expect(attempt).rejects.toMatchObject({ constraint: 'wager_transactions_idempotency_key_key' });
  });

  it('persists a PENDING_REFERENCE transaction, then its resolution, and finds reversals', async () => {
    const wallet = await persistedWallet('100.00');
    const placed = await placeBet(wallet.id, '25.00');
    const refund = bet(wallet, '25.00', { kind: WagerTransactionKind.Refund, reference: placed.externalTransactionId });
    refund.markPendingReference(new Date(), brl('75.00'), retry);
    await uow.run((repos) => repos.transactions.insert(refund));

    const pending = await uow.run((repos) => repos.transactions.findById(refund.id));
    expect(pending?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pending?.referenceAttempts).toBe(1);
    expect(await uow.run((repos) => repos.transactions.hasProcessedReversal(placed.id))).toBe(false);

    pending!.markProcessed(placed.id, new Date(), brl('100.00'));
    await uow.run((repos) => repos.transactions.update(pending!));

    const byExternalId = await uow.run((repos) => repos.transactions.findByExternalId('provider-a', refund.externalTransactionId));
    expect(byExternalId?.status).toBe(WagerTransactionStatus.Processed);
    expect(byExternalId?.referenceTransactionId).toBe(placed.id);
    expect(await uow.run((repos) => repos.transactions.hasProcessedReversal(placed.id))).toBe(true);
  });

  it('inbox: the first insert wins, a redelivery gets the existing record back', async () => {
    const message = InboxMessage.receive({ messageId: uuid(), consumerName: 'wager-consumer', payloadHash: 'abc', receivedAt: new Date() });
    message.markProcessed(new Date());

    const first = await uow.run((repos) => repos.inbox.insertIfAbsent(message));
    const second = await uow.run((repos) => repos.inbox.insertIfAbsent(message));

    expect(first).toBeUndefined();
    expect(second?.isProcessed()).toBe(true);
    expect(second?.matchesPayload('abc')).toBe(true);
  });

  it('outbox: events are stored with the envelope as jsonb', async () => {
    const wallet = await persistedWallet('100.00');
    const transaction = await placeBet(wallet.id, '5.00');
    const event = WagerTransactionProcessed.from(transaction, { eventId: uuid(), correlationId: 'corr-1', occurredAt: new Date() });

    await uow.run((repos) => repos.outbox.enqueue([OutboxMessage.enqueue(event)]));

    const [row] = await orm.em.fork().getConnection().execute('select payload, published_at from outbox_messages where id = ?', [event.eventId]);
    expect(row?.published_at).toBeNull();
    expect(row?.payload).toMatchObject({ eventType: 'WagerTransactionProcessed', data: { money: { amount: '5.00', currency: 'BRL' } } });
  });
});
