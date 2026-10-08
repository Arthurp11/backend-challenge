import { describe, expect, it } from 'bun:test';
import type { EventContext } from '../../../src/domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../../src/domain/events/wagering-events';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction';
import { apply, brl, NOW, openWallet, wager } from '../../support/domain-builders';

const ctx: EventContext = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: NOW };

describe('integration events', () => {
  it('WalletBalanceChanged carries the ledger movement as JSON-safe data', () => {
    const { wallet } = openWallet('100.00');
    const bet = wager({ money: brl('25.00') });
    const entry = apply(wallet, bet)!;

    const event = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(JSON.parse(JSON.stringify(event))).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-01-01T12:00:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: bet.id,
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('WagerTransactionProcessed is keyed by the wallet and records the observed balance', () => {
    const { wallet } = openWallet('100.00');
    const loss = wager({ kind: WagerTransactionKind.Loss, money: brl('0.00') });
    apply(wallet, loss);

    const event = WagerTransactionProcessed.from(loss, ctx);

    expect(event.aggregateId).toBe('wallet-1');
    expect(event.data.kind).toBe(WagerTransactionKind.Loss);
    expect(event.data.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(event.data.referenceTransactionId).toBeNull();
  });

  it('WagerTransactionRejected carries the failure code', () => {
    const { wallet } = openWallet('10.00');
    const bet = wager({ money: brl('25.00') });
    apply(wallet, bet);

    const event = WagerTransactionRejected.from(bet, ctx);

    expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  it('WagerTransactionPendingReference carries what it waits for and when it retries', () => {
    const { wallet } = openWallet('100.00');
    const refund = wager({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' });
    apply(wallet, refund, { kind: 'missing' });

    const event = WagerTransactionPendingReference.from(refund, ctx);

    expect(event.data.referenceExternalTransactionId).toBe('bet-1');
    expect(event.data.nextAttemptAt).toBe('2026-01-01T12:00:01.000Z');
  });

  it('refuses to build an event that does not match the transaction status', () => {
    const { wallet } = openWallet('100.00');
    const bet = wager();
    apply(wallet, bet);

    expect(() => WagerTransactionRejected.from(bet, ctx)).toThrow();
    expect(() => WagerTransactionPendingReference.from(bet, ctx)).toThrow();
  });

  it('omits causationId when there is none, and data cannot be changed', () => {
    const { wallet } = openWallet('100.00');
    const bet = wager();
    apply(wallet, bet);

    const event = WagerTransactionProcessed.from(bet, { ...ctx, causationId: undefined });

    expect('causationId' in event.toJSON()).toBe(false);
    expect(Object.isFrozen(event.data)).toBe(true);
  });
});
