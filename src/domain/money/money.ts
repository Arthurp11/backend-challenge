import { DomainError } from '../shared/domain-error';

/** Wire format of money in every contract (HTTP, SQS, events): decimal string with scale 2. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const MINOR_UNITS_PER_UNIT = 100n;
/** Largest absolute value that fits the `numeric(20,2)` columns: 18 integer digits and 2 decimals. */
const MAX_MINOR_UNITS = 10n ** 20n - 1n;
/** Non-negative decimal without sign, exponent or leading zeros: up to 18 integer digits and 2 decimals. */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(?:\.(\d{1,2}))?$/;
/** ISO-4217 shape (three upper-case letters). The list of existing codes is not enforced. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, actual: string) {
    super(`currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/**
 * Immutable money value. The amount is an integer count of minor units (cents) held in a `bigint`,
 * so arithmetic is exact: no `number`, no floating point and no rounding anywhere.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  /**
   * Parses a value from an input contract (or from a `numeric(20,2)` column).
   * Accepts up to 2 decimals and normalizes to scale 2 ("25" and "25.5" become "25.00" and "25.50");
   * rejects anything that would need rounding or is not a plain non-negative decimal string.
   */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    const match = typeof amount === 'string' ? AMOUNT_PATTERN.exec(amount) : null;
    if (!match) {
      throw new InvalidMoneyError(`invalid amount: expected a non-negative decimal string, got ${describe(amount)}`);
    }
    const [, integerDigits = '0', fractionDigits = ''] = match;
    const minorUnits = BigInt(integerDigits) * MINOR_UNITS_PER_UNIT + BigInt(fractionDigits.padEnd(SCALE, '0'));
    return Money.of(minorUnits, assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.minorUnits + other.minorUnits, this.currency);
  }

  /** May produce a negative value: forbidding negative balances is the Wallet's rule, not Money's. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return Money.of(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** Value equality. Different currencies are simply not equal (a question, not an operation). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  /** Called by `JSON.stringify`, so a `bigint` never reaches responses, events or logs. */
  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const sign = this.minorUnits < 0n ? '-' : '';
    const absolute = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    const units = absolute / MINOR_UNITS_PER_UNIT;
    const cents = (absolute % MINOR_UNITS_PER_UNIT).toString().padStart(SCALE, '0');
    return `${sign}${units}.${cents}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  /** Every instance goes through here, so no Money can exist that the database could not store. */
  private static of(minorUnits: bigint, currency: string): Money {
    if (minorUnits > MAX_MINOR_UNITS || minorUnits < -MAX_MINOR_UNITS) {
      throw new InvalidMoneyError('amount out of range: does not fit numeric(20,2)');
    }
    return new Money(minorUnits, currency);
  }
}

function assertCurrency(currency: unknown): string {
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError(`invalid currency: expected an ISO-4217 code, got ${describe(currency)}`);
  }
  return currency;
}

/** Safe description of an untrusted value for error messages (JSON.stringify throws on bigint). */
function describe(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : typeof value;
}
