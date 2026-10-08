import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { InvalidWagerTransactionError, WagerTransactionKind, WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction';
import { apply, brl, found, later, openWallet, referenceRetry, usd, wager } from '../../support/domain-builders';

const { Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;
const { Processed, Rejected, PendingReference } = WagerTransactionStatus;

/** A processed BET of `amount` on a fresh 100.00 wallet, ready to be referenced. */
function walletWithBet(amount = '25.00') {
  const { wallet } = openWallet('100.00');
  const bet = wager({ externalTransactionId: 'bet-1', money: brl(amount) });
  apply(wallet, bet);
  return { wallet, bet };
}

describe('applyWagerTransaction', () => {
  describe('BET', () => {
    it('debits the wallet and writes one DEBIT entry', () => {
      const { wallet } = openWallet('100.00');
      const bet = wager({ money: brl('25.00') });

      const entry = apply(wallet, bet);

      expect(bet.status).toBe(Processed);
      expect(bet.resultBalance?.equals(brl('75.00'))).toBe(true);
      expect(wallet.balance.equals(brl('75.00'))).toBe(true);
      expect(entry?.direction).toBe(LedgerDirection.Debit);
      expect(entry?.transactionId).toBe(bet.id);
    });

    it('is REJECTED with INSUFFICIENT_FUNDS when larger than the balance, without touching the wallet', () => {
      const { wallet } = openWallet('100.00');
      const bet = wager({ money: brl('100.01') });

      const entry = apply(wallet, bet);

      expect(bet.status).toBe(Rejected);
      expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(bet.resultBalance?.equals(brl('100.00'))).toBe(true);
      expect(entry).toBeUndefined();
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      expect(wallet.version).toBe(1);
    });

    it('§8 rule: from 100.00, two BETs of 80.00 -> one PROCESSED, one REJECTED, balance 20.00', () => {
      const { wallet } = openWallet('100.00');
      const first = wager({ externalTransactionId: 'bet-a', money: brl('80.00') });
      const second = wager({ externalTransactionId: 'bet-b', money: brl('80.00') });

      const entries = [apply(wallet, first), apply(wallet, second)].filter(Boolean);

      expect([first.status, second.status]).toEqual([Processed, Rejected]);
      expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(entries).toHaveLength(1);
    });
  });

  describe('WIN', () => {
    it('credits the wallet', () => {
      const { wallet } = openWallet('100.00');

      const entry = apply(wallet, wager({ kind: Win, money: brl('40.00') }));

      expect(wallet.balance.equals(brl('140.00'))).toBe(true);
      expect(entry?.direction).toBe(LedgerDirection.Credit);
    });

    it('may reference the BET of the same round', () => {
      const { wallet, bet } = walletWithBet();
      const win = wager({ kind: Win, externalTransactionId: 'win-1', money: brl('60.00'), referenceExternalTransactionId: 'bet-1' });

      apply(wallet, win, found(bet));

      expect(win.status).toBe(Processed);
      expect(win.referenceTransactionId).toBe(bet.id);
    });
  });

  describe('LOSS', () => {
    it('is PROCESSED without moving the balance, without an entry and without a new version', () => {
      const { wallet } = openWallet('100.00');
      const loss = wager({ kind: Loss, money: brl('0.00') });

      const entry = apply(wallet, loss);

      expect(loss.status).toBe(Processed);
      expect(entry).toBeUndefined();
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      expect(wallet.version).toBe(1);
    });
  });

  describe('REFUND', () => {
    const refundOf = (reference: string, amount = '25.00') =>
      wager({ kind: Refund, externalTransactionId: 'refund-1', money: brl(amount), referenceExternalTransactionId: reference });

    it('credits back the referenced BET', () => {
      const { wallet, bet } = walletWithBet('25.00');
      const refund = refundOf('bet-1');

      const entry = apply(wallet, refund, found(bet));

      expect(refund.status).toBe(Processed);
      expect(refund.referenceTransactionId).toBe(bet.id);
      expect(entry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('rejects a different amount (no partial reversal)', () => {
      const { wallet, bet } = walletWithBet('25.00');
      const refund = refundOf('bet-1', '10.00');

      apply(wallet, refund, found(bet));

      expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    });

    it('rejects a reference that is not a BET', () => {
      const { wallet } = openWallet('100.00');
      const win = wager({ kind: Win, externalTransactionId: 'win-1' });
      apply(wallet, win);
      const refund = refundOf('win-1');

      apply(wallet, refund, found(win));

      expect(refund.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
    });

    it('rejects a reference that was already reversed', () => {
      const { wallet, bet } = walletWithBet('25.00');
      const refund = refundOf('bet-1');

      apply(wallet, refund, found(bet, true));

      expect(refund.failureCode).toBe(FailureCode.AlreadyReversed);
      expect(wallet.balance.equals(brl('75.00'))).toBe(true);
    });

    it('rejects a reference that ended REJECTED', () => {
      const { wallet } = openWallet('10.00');
      const bet = wager({ externalTransactionId: 'bet-1', money: brl('25.00') });
      apply(wallet, bet);
      const refund = refundOf('bet-1');

      apply(wallet, refund, found(bet));

      expect(bet.status).toBe(Rejected);
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
      expect(wallet.balance.equals(brl('10.00'))).toBe(true);
    });

    it.each([
      ['another round', { roundId: 'round-2' }],
      ['another provider', { providerId: 'provider-b' }],
    ])('rejects a reference from %s', (_case, overrides) => {
      const { wallet, bet } = walletWithBet('25.00');
      const refund = wager({ kind: Refund, externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1', ...overrides });

      apply(wallet, refund, found(bet));

      expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
    });
  });

  describe('ROLLBACK', () => {
    const rollbackOf = (reference: string, amount: string) =>
      wager({ kind: Rollback, externalTransactionId: `rollback-${reference}`, money: brl(amount), referenceExternalTransactionId: reference });

    it('of a BET credits it back', () => {
      const { wallet, bet } = walletWithBet('25.00');

      const entry = apply(wallet, rollbackOf('bet-1', '25.00'), found(bet));

      expect(entry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('of a WIN debits it back', () => {
      const { wallet } = openWallet('100.00');
      const win = wager({ kind: Win, externalTransactionId: 'win-1', money: brl('40.00') });
      apply(wallet, win);

      const entry = apply(wallet, rollbackOf('win-1', '40.00'), found(win));

      expect(entry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('of a REFUND debits it back', () => {
      const { wallet, bet } = walletWithBet('25.00');
      const refund = wager({ kind: Refund, externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1' });
      apply(wallet, refund, found(bet));

      const entry = apply(wallet, rollbackOf('refund-1', '25.00'), found(refund));

      expect(entry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.equals(brl('75.00'))).toBe(true);
    });

    it('of a WIN already spent is REJECTED with REVERSAL_INSUFFICIENT_FUNDS (not INSUFFICIENT_FUNDS)', () => {
      const { wallet } = openWallet('0.00');
      const win = wager({ kind: Win, externalTransactionId: 'win-1', money: brl('40.00') });
      apply(wallet, win);
      apply(wallet, wager({ externalTransactionId: 'bet-2', money: brl('30.00') }));
      const rollback = rollbackOf('win-1', '40.00');

      apply(wallet, rollback, found(win));

      expect(rollback.status).toBe(Rejected);
      expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
      expect(wallet.balance.equals(brl('10.00'))).toBe(true);
    });

    it('of a LOSS is not allowed', () => {
      const { wallet } = openWallet('100.00');
      const loss = wager({ kind: Loss, externalTransactionId: 'loss-1', money: brl('0.00') });
      apply(wallet, loss);
      const rollback = wager({ kind: Rollback, externalTransactionId: 'rb-1', money: brl('1.00'), referenceExternalTransactionId: 'loss-1' });

      apply(wallet, rollback, found(loss));

      expect(rollback.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
    });
  });

  describe('reference that has not arrived yet', () => {
    const lateRefund = () =>
      wager({ kind: Refund, externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1' });

    it('parks the transaction as PENDING_REFERENCE without touching the wallet', () => {
      const { wallet } = openWallet('100.00');
      const refund = lateRefund();

      const entry = apply(wallet, refund, { kind: 'missing' });

      expect(refund.status).toBe(PendingReference);
      expect(refund.referenceAttempts).toBe(1);
      expect(refund.nextReferenceAttemptAt).toEqual(later(1_000));
      expect(entry).toBeUndefined();
      expect(wallet.version).toBe(1);
    });

    it('is applied on a retry once the reference exists', () => {
      const { wallet } = openWallet('100.00');
      const refund = lateRefund();
      apply(wallet, refund, { kind: 'missing' });
      const bet = wager({ externalTransactionId: 'bet-1' });
      apply(wallet, bet);

      apply(wallet, refund, found(bet), { at: later(1_000) });

      expect(refund.status).toBe(Processed);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('keeps waiting while the reference itself is still pending', () => {
      const { wallet } = openWallet('100.00');
      const win = wager({ kind: Win, externalTransactionId: 'win-1', referenceExternalTransactionId: 'bet-1' });
      apply(wallet, win, { kind: 'missing' });
      const rollback = wager({ kind: Rollback, externalTransactionId: 'rb-1', referenceExternalTransactionId: 'win-1' });

      apply(wallet, rollback, found(win));

      expect(rollback.status).toBe(PendingReference);
    });

    it('is REJECTED with REFERENCE_NOT_FOUND once the retries are exhausted', () => {
      const { wallet } = openWallet('100.00');
      const refund = lateRefund();

      for (let attempt = 0; attempt <= referenceRetry.maxAttempts; attempt++) {
        apply(wallet, refund, { kind: 'missing' }, { at: later(attempt * 60_000) });
      }

      expect(refund.status).toBe(Rejected);
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(wallet.version).toBe(1);
    });
  });

  describe('wallet context', () => {
    it('rejects a transaction of another player with PLAYER_WALLET_MISMATCH', () => {
      const { wallet } = openWallet('100.00');
      const bet = wager({ playerId: 'player-2' });

      apply(wallet, bet);

      expect(bet.failureCode).toBe(FailureCode.PlayerWalletMismatch);
    });

    it('rejects a transaction in another currency with CURRENCY_MISMATCH', () => {
      const { wallet } = openWallet('100.00');
      const bet = wager({ money: usd('25.00') });

      apply(wallet, bet);

      expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });
  });

  describe('caller contract (bugs, not business outcomes)', () => {
    it('refuses to apply a transaction that is already terminal', () => {
      const { wallet } = openWallet('100.00');
      const bet = wager();
      apply(wallet, bet);

      expect(() => apply(wallet, bet)).toThrow(InvalidWagerTransactionError);
      expect(wallet.balance.equals(brl('75.00'))).toBe(true);
    });

    it('refuses a reference resolution that does not match the transaction', () => {
      const { wallet } = openWallet('100.00');

      expect(() => apply(wallet, wager(), { kind: 'missing' })).toThrow(InvalidWagerTransactionError);
    });
  });
});
