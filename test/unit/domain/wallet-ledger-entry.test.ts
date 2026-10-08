import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import {
  type CreateLedgerEntryProps,
  InvalidLedgerEntryError,
  WalletLedgerEntry,
} from '../../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../../src/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

/** A valid CREDIT of 10.00 (90.00 → 100.00). Each test overrides only what it is about. */
const validProps = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Credit,
  money: brl('10.00'),
  balanceBefore: brl('90.00'),
  balanceAfter: brl('100.00'),
  walletVersion: 2,
  createdAt: new Date('2026-01-01T12:00:00Z'),
  ...overrides,
});

describe('WalletLedgerEntry', () => {
  describe('create', () => {
    it('creates a CREDIT entry when balanceAfter = balanceBefore + money', () => {
      const entry = WalletLedgerEntry.create(validProps());

      // Checking every field also catches arguments passed to the constructor in the wrong order.
      expect(entry.id).toBe('entry-1');
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.transactionId).toBe('tx-1');
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.money.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
      expect(entry.balanceBefore.toJSON()).toEqual({ amount: '90.00', currency: 'BRL' });
      expect(entry.balanceAfter.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(entry.walletVersion).toBe(2);
      expect(entry.createdAt.toISOString()).toBe('2026-01-01T12:00:00.000Z');
    });

    it('creates a DEBIT entry when balanceAfter = balanceBefore - money', () => {
      const props = validProps({
        direction: LedgerDirection.Debit,
        balanceBefore: brl('100.00'),
        balanceAfter: brl('90.00'),
      });

      const entry = WalletLedgerEntry.create(props);

      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceAfter.toJSON()).toEqual({ amount: '90.00', currency: 'BRL' });
    });

    it('accepts a DEBIT that takes the balance exactly to zero', () => {
      const props = validProps({
        direction: LedgerDirection.Debit,
        balanceBefore: brl('10.00'),
        balanceAfter: brl('0.00'),
      });

      expect(() => WalletLedgerEntry.create(props)).not.toThrow();
    });

    it('rejects an entry whose arithmetic does not add up', () => {
      const props = validProps({ balanceAfter: brl('105.00') });

      expect(() => WalletLedgerEntry.create(props)).toThrow(InvalidLedgerEntryError);
    });

    it('rejects a DEBIT whose numbers only add up as a CREDIT (direction matters)', () => {
      // Same numbers as the valid CREDIT (90.00 + 10.00 = 100.00), only the direction changes.
      const props = validProps({ direction: LedgerDirection.Debit });

      expect(() => WalletLedgerEntry.create(props)).toThrow(InvalidLedgerEntryError);
    });

    it('rejects zero money (an entry that does not move the balance is not an entry)', () => {
      const props = validProps({ money: brl('0.00'), balanceAfter: brl('90.00') });

      expect(() => WalletLedgerEntry.create(props)).toThrow(InvalidLedgerEntryError);
    });

    it('rejects a balanceAfter below zero', () => {
      // Money.from rejects "-10.00" (input contract), so the negative value comes from arithmetic.
      const props = validProps({
        direction: LedgerDirection.Debit,
        money: brl('100.00'),
        balanceBefore: brl('90.00'),
        balanceAfter: brl('90.00').subtract(brl('100.00')),
      });

      expect(() => WalletLedgerEntry.create(props)).toThrow(InvalidLedgerEntryError);
    });

    it.each([
      ['money', { money: usd('10.00') }],
      ['balanceBefore', { balanceBefore: usd('90.00') }],
      ['balanceAfter', { balanceAfter: usd('100.00') }],
    ])('rejects a different currency in %s', (_field, override) => {
      const props = validProps(override);

      expect(() => WalletLedgerEntry.create(props)).toThrow(InvalidLedgerEntryError);
    });

    it.each([0, -1, 1.5])('rejects walletVersion %p (must be an integer >= 1)', (walletVersion) => {
      const props = validProps({ walletVersion });

      expect(() => WalletLedgerEntry.create(props)).toThrow(InvalidLedgerEntryError);
    });
  });

  describe('rehydrate', () => {
    it('rebuilds persisted state without validating it again', () => {
      const corrupt = validProps({ balanceAfter: brl('105.00') });

      const entry = WalletLedgerEntry.rehydrate(corrupt);

      expect(entry.id).toBe('entry-1');
      expect(entry.balanceAfter.toJSON()).toEqual({ amount: '105.00', currency: 'BRL' });
    });

    it('isBalanced() is true for every entry built by create', () => {
      const credit = WalletLedgerEntry.create(validProps());
      const debit = WalletLedgerEntry.create(
        validProps({ direction: LedgerDirection.Debit, balanceBefore: brl('100.00'), balanceAfter: brl('90.00') }),
      );

      expect(credit.isBalanced()).toBe(true);
      expect(debit.isBalanced()).toBe(true);
    });

    it('isBalanced() returns false when the persisted numbers do not add up (how reconciliation spots corruption)', () => {
      const entry = WalletLedgerEntry.rehydrate(validProps({ balanceAfter: brl('105.00') }));

      expect(entry.isBalanced()).toBe(false);
    });

    it('isBalanced() returns false instead of throwing when persisted currencies are mixed', () => {
      const entry = WalletLedgerEntry.rehydrate(validProps({ balanceBefore: usd('90.00') }));

      expect(entry.isBalanced()).toBe(false);
    });
  });

  describe('immutability', () => {
    it('has no way to change a field after creation (compile time and runtime)', () => {
      const entry = WalletLedgerEntry.create(validProps());

      expect(() => {
        // @ts-expect-error balanceAfter is readonly. If it ever stops being readonly, the typecheck fails here.
        entry.balanceAfter = brl('1000.00');
      }).toThrow(TypeError);
      expect(entry.balanceAfter.toJSON().amount).toBe('100.00');
    });
  });
});
