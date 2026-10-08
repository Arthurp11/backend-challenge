import { LedgerDirection } from '../ledger/ledger-direction';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { CurrencyMismatchError, Money } from '../money/money';
import { DomainError } from '../shared/domain-error';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Ids of the internal OPENING transaction and its ledger entry. Used only when initialBalance > 0. */
  opening: { transactionId: string; entryId: string };
  at: Date;
}

export interface BalanceMovement {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(balance: Money, requested: Money) {
    super(`insufficient funds: balance ${balance}, requested ${requested}`);
  }
}

export class InvalidWalletOperationError extends DomainError {
  readonly code = 'INVALID_WALLET_OPERATION';

  constructor(message: string) {
    super(message);
  }
}

/**
 * Aggregate root of the balance. The only way to change `balance` is `debit`/`credit`, and both
 * return the ledger entry for that change, so balance and ledger cannot drift apart.
 * `version` starts at 1 and increments only when the balance changes (optimistic check in the UPDATE).
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet at version 1. A positive initial balance is an internal OPENING credit with its
   * own ledger entry (balance 0.00 → initialBalance), recorded in the same transaction as the wallet.
   */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    const { id, playerId, initialBalance, opening, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletOperationError('initial balance cannot be negative');
    }
    const wallet = new Wallet(id, playerId, initialBalance.currency, initialBalance, 1, at, at);
    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    const openingEntry = WalletLedgerEntry.create({
      id: opening.entryId,
      walletId: id,
      transactionId: opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence: does not revalidate anything. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Lets callers pick the right failure code (a BET and a reversal fail with different codes). */
  hasSufficientFunds(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertMovable(movement.money);
    if (!this.hasSufficientFunds(movement.money)) {
      throw new InsufficientFundsError(this._balance, movement.money);
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(movement.money), movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertMovable(movement.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(movement.money), movement);
  }

  private apply(direction: LedgerDirection, balanceAfter: Money, movement: BalanceMovement): WalletLedgerEntry {
    // Built before mutating: if the entry is invalid, the wallet stays untouched.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError('a balance movement must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
