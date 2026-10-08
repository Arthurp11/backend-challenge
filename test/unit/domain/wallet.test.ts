import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import type { WalletLedgerEntry } from '../../../src/domain/ledger/wallet-ledger-entry';
import { CurrencyMismatchError, Money } from '../../../src/domain/money/money';
import { InsufficientFundsError, InvalidWalletOperationError, Wallet } from '../../../src/domain/wallet/wallet';
import { brl, later, NOW, openWallet, usd } from '../../support/domain-builders';

const movement = (amount: string, n = 1) => ({ money: brl(amount), transactionId: `tx-${n}`, entryId: `entry-${n}`, at: later(n) });

describe('Wallet', () => {
  describe('open', () => {
    it('starts at version 1 with the initial balance and an OPENING credit entry', () => {
      const { wallet, openingEntry } = openWallet('100.00');

      expect(wallet.version).toBe(1);
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry?.transactionId).toBe('tx-opening');
      expect(openingEntry?.balanceBefore.isZero()).toBe(true);
      expect(openingEntry?.balanceAfter.equals(brl('100.00'))).toBe(true);
      expect(openingEntry?.walletVersion).toBe(1);
    });

    it('creates no ledger entry for a zero initial balance', () => {
      const { wallet, openingEntry } = openWallet('0.00');

      expect(wallet.version).toBe(1);
      expect(wallet.balance.isZero()).toBe(true);
      expect(openingEntry).toBeUndefined();
    });
  });

  describe('debit and credit', () => {
    it('debit lowers the balance, bumps the version and returns the matching DEBIT entry', () => {
      const { wallet } = openWallet('100.00');

      const entry = wallet.debit(movement('25.00'));

      expect(wallet.balance.equals(brl('75.00'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(later(1));
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
      expect(entry.balanceAfter.equals(brl('75.00'))).toBe(true);
      expect(entry.walletVersion).toBe(2);
    });

    it('credit raises the balance and returns the matching CREDIT entry', () => {
      const { wallet } = openWallet('100.00');

      const entry = wallet.credit(movement('50.00'));

      expect(wallet.balance.equals(brl('150.00'))).toBe(true);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.walletVersion).toBe(2);
    });

    it('can debit exactly the whole balance', () => {
      const { wallet } = openWallet('80.00');

      wallet.debit(movement('80.00'));

      expect(wallet.balance.isZero()).toBe(true);
    });
  });

  describe('invariants', () => {
    it('never goes negative: debiting more than the balance throws and changes nothing', () => {
      const { wallet } = openWallet('100.00');

      expect(() => wallet.debit(movement('100.01'))).toThrow(InsufficientFundsError);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      expect(wallet.version).toBe(1);
    });

    it.each([
      ['debit', (wallet: Wallet) => wallet.debit({ ...movement('1.00'), money: usd('1.00') })],
      ['credit', (wallet: Wallet) => wallet.credit({ ...movement('1.00'), money: usd('1.00') })],
    ])('%s in another currency throws CurrencyMismatchError and changes nothing', (_name, operation) => {
      const { wallet } = openWallet('100.00');

      expect(() => operation(wallet)).toThrow(CurrencyMismatchError);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      expect(wallet.version).toBe(1);
    });

    it.each(['debit', 'credit'] as const)('%s of zero is not a movement', (operation) => {
      const { wallet } = openWallet('100.00');

      expect(() => wallet[operation](movement('0.00'))).toThrow(InvalidWalletOperationError);
      expect(wallet.version).toBe(1);
    });

    it('asking about funds does not change the version (only balance changes do)', () => {
      const { wallet } = openWallet('100.00');

      wallet.hasSufficientFunds(brl('500.00'));

      expect(wallet.version).toBe(1);
    });

    it('the ledger rebuilds the balance: every change has exactly one entry, chained by version', () => {
      const { wallet, openingEntry } = openWallet('100.00');
      const entries: WalletLedgerEntry[] = [openingEntry!];

      entries.push(wallet.debit(movement('30.00', 1)));
      entries.push(wallet.credit(movement('12.50', 2)));
      entries.push(wallet.debit(movement('82.50', 3)));
      entries.push(wallet.credit(movement('0.01', 4)));

      const rebuilt = entries.reduce(
        (sum, entry) => (entry.direction === LedgerDirection.Credit ? sum.add(entry.money) : sum.subtract(entry.money)),
        Money.zero('BRL'),
      );
      expect(rebuilt.equals(wallet.balance)).toBe(true);
      expect(entries.map((entry) => entry.walletVersion)).toEqual([1, 2, 3, 4, 5]);
      expect(wallet.version).toBe(5);
      entries.slice(1).forEach((entry, i) => {
        expect(entry.balanceBefore.equals(entries[i]!.balanceAfter)).toBe(true);
      });
    });
  });

  describe('rehydrate', () => {
    it('rebuilds persisted state as-is, without validating it', () => {
      const negative = brl('0.00').subtract(brl('5.00'));

      const wallet = Wallet.rehydrate({
        id: 'wallet-9',
        playerId: 'player-9',
        currency: 'BRL',
        balance: negative,
        version: 7,
        createdAt: NOW,
        updatedAt: later(1),
      });

      expect(wallet.balance.isNegative()).toBe(true);
      expect(wallet.version).toBe(7);
    });
  });
});
