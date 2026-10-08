import type { Money } from '../money/money';
import { DomainError } from '../shared/domain-error';
import { LedgerDirection } from './ledger-direction';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version after this change. */
  walletVersion: number;
  createdAt: Date;
}

/** Persisted shape. Same fields as the create props, but rebuilt without validation. */
export type LedgerEntryState = CreateLedgerEntryProps;

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';

  constructor(message: string) {
    super(message);
  }
}

/**
 * Immutable ledger line: no setters and no transition methods. `readonly` blocks reassignment at
 * compile time and `Object.freeze` at runtime, so immutability is structural, not a convention.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Validates the entry (currencies, amounts, version and arithmetic) before building it. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter, walletVersion } = props;
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvalidLedgerEntryError('money, balanceBefore and balanceAfter must share one currency');
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError('money must be positive: an entry that does not move the balance is not an entry');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('balances cannot be negative');
    }
    if (!Number.isInteger(walletVersion) || walletVersion < 1) {
      throw new InvalidLedgerEntryError(`walletVersion must be an integer >= 1, got ${walletVersion}`);
    }

    const entry = WalletLedgerEntry.build(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError('balanceAfter does not match balanceBefore ± money');
    }
    return entry;
  }

  /** Rebuilds an already persisted entry. Does not validate: `isBalanced()` is how corruption is detected. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** balanceBefore ± money === balanceAfter, according to the direction. Never throws, even on corrupt data. */
  isBalanced(): boolean {
    const { money, balanceBefore, balanceAfter } = this;
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      return false;
    }
    const expectedAfter =
      this.direction === LedgerDirection.Credit ? balanceBefore.add(money) : balanceBefore.subtract(money);
    return expectedAfter.equals(balanceAfter);
  }

  private static build(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }
}
