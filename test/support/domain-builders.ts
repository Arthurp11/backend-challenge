import { Money } from '../../src/domain/money/money';
import { BackoffPolicy } from '../../src/domain/shared/backoff-policy';
import { type ApplyWagerTransactionInput, applyWagerTransaction, type ReferenceResolution } from '../../src/domain/wagering/apply-wager-transaction';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

export const NOW = new Date('2026-01-01T12:00:00.000Z');
export const later = (ms: number) => new Date(NOW.getTime() + ms);

/** 1s, 2s, 4s… parked at most 3 times before REFERENCE_NOT_FOUND. */
export const referenceRetry = BackoffPolicy.exponential({ baseDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 3 });

/** wallet-1 of player-1 in BRL. */
export function openWallet(initialBalance = '100.00'): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initialBalance),
    opening: { transactionId: 'tx-opening', entryId: 'entry-opening' },
    at: NOW,
  });
}

/** A valid BET of 25.00 on wallet-1, round-1. Each test overrides only what it is about. */
export function wagerProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  const externalTransactionId = overrides.externalTransactionId ?? 'ext-1';
  return {
    id: `tx-${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    createdAt: NOW,
    ...overrides,
  };
}

export function wager(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create(wagerProps(overrides));
}

/** Runs the business rules the way the use case will: one call per arrival or retry. */
export function apply(
  wallet: Wallet,
  transaction: WagerTransaction,
  reference: ReferenceResolution = { kind: 'none' },
  overrides: Partial<ApplyWagerTransactionInput> = {},
): WalletLedgerEntry | undefined {
  return applyWagerTransaction({
    wallet,
    transaction,
    reference,
    entryId: `entry-${transaction.id}`,
    at: NOW,
    referenceRetry,
    ...overrides,
  }).entry;
}

/** A reference that exists and was not reversed yet. */
export const found = (transaction: WagerTransaction, alreadyReversed = false): ReferenceResolution => ({
  kind: 'found',
  transaction,
  alreadyReversed,
});
