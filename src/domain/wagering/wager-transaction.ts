import { LedgerDirection } from '../ledger/ledger-direction';
import type { Money } from '../money/money';
import type { BackoffPolicy } from '../shared/backoff-policy';
import { DomainError } from '../shared/domain-error';
import type { FailureCode } from './failure-code';
import { wagerPayloadHash } from './payload-hash';

export enum WagerTransactionKind {
  /** Internal: initial credit of a wallet. Never accepted from the API or the queue. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Accepted, not applied yet (only exists inside the processing transaction). */
  Pending = 'PENDING',
  /** Waiting for the referenced transaction to arrive. */
  PendingReference = 'PENDING_REFERENCE',
  /** Applied. Terminal. */
  Processed = 'PROCESSED',
  /** Business rule violation. Terminal. */
  Rejected = 'REJECTED',
  /** Permanent infrastructure error. Terminal, kept for audit. */
  Failed = 'FAILED',
}

const TERMINAL = new Set([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed]);
const REQUIRES_REFERENCE = new Set([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);
const MAY_REFERENCE = new Set([...REQUIRES_REFERENCE, WagerTransactionKind.Win, WagerTransactionKind.Loss]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  /** Undefined only for OPENING. */
  roundId: string | undefined;
  gameId: string | undefined;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  /** Balance observed when the transaction reached its current status (returned on replay). */
  resultBalance: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
}

/** Invalid input: the request itself is malformed (maps to "invalid payload", never persisted). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';

  constructor(message: string) {
    super(message);
  }
}

/** Programming error: a transition that the state machine does not allow. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(from: WagerTransactionStatus, to: WagerTransactionStatus) {
    super(`invalid transition ${from} -> ${to}`);
  }
}

/**
 * A provider operation on a wallet. State machine:
 *
 *   PENDING ──► PROCESSED | REJECTED | FAILED
 *      │
 *      └──► PENDING_REFERENCE ──► (itself, on each retry) | PROCESSED | REJECTED | FAILED
 *
 * PROCESSED, REJECTED and FAILED are terminal: any transition out of them throws.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | undefined,
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** Id at the provider, not the internal id. */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  /** A provider transaction (API or queue). Born PENDING; validates the input contract per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId } = props;
    for (const field of ['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'walletId', 'playerId', 'roundId', 'gameId'] as const) {
      if (typeof props[field] !== 'string' || props[field].trim() === '') {
        throw new InvalidWagerTransactionError(`${field} is required`);
      }
    }
    if (!Object.values(WagerTransactionKind).includes(kind) || kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(`kind ${String(kind)} cannot be submitted`);
    }
    if (REQUIRES_REFERENCE.has(kind) && !referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${kind} requires referenceExternalTransactionId`);
    }
    if (referenceExternalTransactionId !== undefined && !MAY_REFERENCE.has(kind)) {
      throw new InvalidWagerTransactionError(`${kind} cannot reference another transaction`);
    }
    if (kind === WagerTransactionKind.Loss ? money.isNegative() : !money.isPositive()) {
      throw new InvalidWagerTransactionError(`${kind} amount must be ${kind === WagerTransactionKind.Loss ? '>= 0' : '> 0'}`);
    }
    return WagerTransaction.pending({ ...props, payloadHash: wagerPayloadHash(props) });
  }

  /** The internal credit that opens a wallet with a positive balance. */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    const fields = {
      ...props,
      providerId: 'internal',
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `internal:opening:${props.walletId}`,
      roundId: undefined,
      gameId: undefined,
      kind: WagerTransactionKind.Opening,
      referenceExternalTransactionId: undefined,
    };
    return WagerTransaction.pending({ ...fields, payloadHash: wagerPayloadHash(fields) });
  }

  /** Reconstruction from persistence: does not revalidate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
  }

  private static pending(
    fields: Omit<WagerTransactionState, 'status' | 'referenceTransactionId' | 'failureCode' | 'processedAt' | 'resultBalance' | 'referenceAttempts' | 'nextReferenceAttemptAt'>,
  ): WagerTransaction {
    return WagerTransaction.rehydrate({
      ...fields,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      resultBalance: undefined,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
    });
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transitions (throw InvalidTransactionStateError when the current status is terminal)

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  /** Parks the transaction until its reference arrives. Each call counts one attempt and schedules the next. */
  markPendingReference(at: Date, resultBalance: Money, retry: BackoffPolicy): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = retry.nextAttemptAt(at, this._referenceAttempts);
    this._resultBalance = resultBalance;
  }

  reject(code: FailureCode, at: Date, resultBalance: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** False for LOSS: it records the result of a round without moving money. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REQUIRES_REFERENCE.has(this.kind);
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  hasExhaustedReferenceAttempts(retry: BackoffPolicy): boolean {
    return retry.isExhausted(this._referenceAttempts);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** BET debits; OPENING, WIN and REFUND credit; ROLLBACK does the inverse of its reference. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError('ROLLBACK needs its reference to know the direction');
        }
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS does not move the balance');
    }
  }

  private assertNotTerminal(to: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, to);
    }
  }
}
