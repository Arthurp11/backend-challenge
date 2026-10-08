import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../../src/domain/money/money';

// Small builders keep each test focused on what it checks, not on how a Money is built.
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money', () => {
  describe('from (input contract)', () => {
    it('keeps a value that already has scale 2', () => {
      const money = brl('25.00');

      expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    });

    // Table-driven test: one test case per row, each reported separately when it fails.
    it.each([
      ['25', '25.00'],
      ['25.5', '25.50'],
      ['0', '0.00'],
      ['0.01', '0.01'],
      ['999999999999999999.99', '999999999999999999.99'],
    ])('normalizes "%s" to scale 2 ("%s")', (input, expected) => {
      expect(brl(input).toJSON().amount).toBe(expected);
    });

    it.each([
      ['an empty string', ''],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['scientific notation', '1e3'],
      ['more than 2 decimals (would need rounding)', '10.005'],
      ['a negative value', '-1.00'],
      ['an explicit plus sign', '+1.00'],
      ['leading zeros', '007.00'],
      ['a missing integer part', '.50'],
      ['a trailing dot', '25.'],
      ['surrounding spaces', ' 25.00 '],
      ['a comma as decimal separator', '25,00'],
      ['more than 18 integer digits', '1000000000000000000.00'],
    ])('rejects %s', (_description, input) => {
      expect(() => brl(input)).toThrow(InvalidMoneyError);
    });

    it('rejects a number instead of a decimal string', () => {
      // The cast simulates untrusted JSON: the type system cannot protect us at runtime.
      const props = { amount: 25 as unknown as string, currency: 'BRL' };

      expect(() => Money.from(props)).toThrow(InvalidMoneyError);
    });

    it.each(['', 'brl', 'BR', 'BRLL', '123'])('rejects the currency "%s"', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });
  });

  describe('arithmetic', () => {
    it('is exact where floating point is not (0.10 + 0.20)', () => {
      // With `number`, 0.1 + 0.2 === 0.30000000000000004.
      const sum = brl('0.10').add(brl('0.20'));

      expect(sum.equals(brl('0.30'))).toBe(true);
    });

    it('never loses a cent across many operations', () => {
      let total = Money.zero('BRL');
      for (let i = 0; i < 1_000; i++) {
        total = total.add(brl('0.01'));
      }

      expect(total.toJSON().amount).toBe('10.00');
    });

    it('subtract can go below zero (forbidding negative balances is the Wallet rule)', () => {
      const result = brl('10.00').subtract(brl('25.50'));

      expect(result.isNegative()).toBe(true);
      expect(result.toJSON().amount).toBe('-15.50');
    });

    it('negate flips the sign', () => {
      expect(brl('25.00').negate().toJSON().amount).toBe('-25.00');
      expect(brl('25.00').negate().negate().equals(brl('25.00'))).toBe(true);
    });

    it('is immutable: operations return new instances', () => {
      const original = brl('10.00');

      const sum = original.add(brl('5.00'));

      expect(original.toJSON().amount).toBe('10.00');
      expect(sum.toJSON().amount).toBe('15.00');
    });

    it('rejects results that would not fit numeric(20,2)', () => {
      const max = brl('999999999999999999.99');

      expect(() => max.add(brl('0.01'))).toThrow(InvalidMoneyError);
    });
  });

  describe('comparisons', () => {
    it('knows zero, positive and negative', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.01').negate().isNegative()).toBe(true);
    });

    it('compares amounts with isLessThan', () => {
      expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
      expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    });

    it('equals compares value, not the text that was received', () => {
      expect(brl('25').equals(brl('25.00'))).toBe(true);
      expect(brl('25.00').equals(usd('25.00'))).toBe(false);
    });
  });

  describe('currency conflicts', () => {
    const operations: Array<[string, (a: Money, b: Money) => unknown]> = [
      ['add', (a, b) => a.add(b)],
      ['subtract', (a, b) => a.subtract(b)],
      ['isLessThan', (a, b) => a.isLessThan(b)],
    ];

    it.each(operations)('%s between different currencies throws CurrencyMismatchError', (_name, operation) => {
      expect(() => operation(brl('1.00'), usd('1.00'))).toThrow(CurrencyMismatchError);
    });
  });

  describe('serialization', () => {
    it('JSON.stringify writes the decimal string, never a number or bigint', () => {
      const json = JSON.stringify({ money: brl('25.5') });

      expect(json).toBe('{"money":{"amount":"25.50","currency":"BRL"}}');
    });

    it('toString is human-readable', () => {
      expect(brl('25').toString()).toBe('25.00 BRL');
    });
  });
});
