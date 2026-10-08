import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction';
import { brl, later, NOW, referenceRetry, wager, wagerProps } from '../../support/domain-builders';

const { Bet, Win, Loss, Refund, Rollback, Opening } = WagerTransactionKind;
const { Pending, PendingReference, Processed, Rejected, Failed } = WagerTransactionStatus;

describe('WagerTransaction', () => {
  describe('create', () => {
    it('is born PENDING, with the payload hash computed and no attempts', () => {
      const transaction = wager();

      expect(transaction.status).toBe(Pending);
      expect(transaction.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(transaction.referenceAttempts).toBe(0);
      expect(transaction.isTerminal()).toBe(false);
    });

    it.each([
      ['OPENING (internal only)', { kind: Opening }],
      ['an unknown kind', { kind: 'JACKPOT' as WagerTransactionKind }],
      ['REFUND without reference', { kind: Refund }],
      ['ROLLBACK without reference', { kind: Rollback }],
      ['BET with a reference', { kind: Bet, referenceExternalTransactionId: 'ext-0' }],
      ['a BET of zero', { money: brl('0.00') }],
      ['a WIN of zero', { kind: Win, money: brl('0.00') }],
      ['an empty providerId', { providerId: '' }],
      ['a blank roundId', { roundId: '   ' }],
    ])('rejects %s', (_case, overrides) => {
      expect(() => wager(overrides)).toThrow(InvalidWagerTransactionError);
    });

    it.each([
      ['a WIN referencing its BET', { kind: Win, referenceExternalTransactionId: 'ext-0' }],
      ['a LOSS of zero', { kind: Loss, money: brl('0.00') }],
      ['a REFUND with reference', { kind: Refund, referenceExternalTransactionId: 'ext-0' }],
    ])('accepts %s', (_case, overrides) => {
      expect(() => wager(overrides)).not.toThrow();
    });

    it('opening() builds the internal OPENING credit with synthetic provider ids', () => {
      const opening = WagerTransaction.opening({ id: 'tx-o', walletId: 'w-1', playerId: 'p-1', money: brl('100.00'), createdAt: NOW });

      expect(opening.kind).toBe(Opening);
      expect(opening.providerId).toBe('internal');
      expect(opening.externalTransactionId).toBe('opening:w-1');
      expect(opening.roundId).toBeUndefined();
      expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });
  });

  describe('state machine', () => {
    it.each([
      ['PROCESSED', (t: WagerTransaction) => t.markProcessed(undefined, NOW, brl('75.00')), Processed],
      ['REJECTED', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, NOW, brl('10.00')), Rejected],
      ['FAILED', (t: WagerTransaction) => t.fail(FailureCode.PermanentProcessingError, NOW), Failed],
      ['PENDING_REFERENCE', (t: WagerTransaction) => t.markPendingReference(NOW, brl('100.00'), referenceRetry), PendingReference],
    ])('PENDING -> %s', (_name, transition, expected) => {
      const transaction = wager();

      transition(transaction);

      expect(transaction.status).toBe(expected);
    });

    it('PENDING_REFERENCE can wait again and then be PROCESSED', () => {
      const transaction = wager({ kind: Refund, referenceExternalTransactionId: 'ext-0' });

      transaction.markPendingReference(NOW, brl('100.00'), referenceRetry);
      transaction.markPendingReference(later(1_000), brl('100.00'), referenceRetry);
      transaction.markProcessed('tx-ext-0', later(3_000), brl('125.00'));

      expect(transaction.status).toBe(Processed);
      expect(transaction.referenceTransactionId).toBe('tx-ext-0');
      expect(transaction.nextReferenceAttemptAt).toBeUndefined();
      expect(transaction.resultBalance?.equals(brl('125.00'))).toBe(true);
    });

    const terminalStates: Array<[string, (t: WagerTransaction) => void]> = [
      ['PROCESSED', (t) => t.markProcessed(undefined, NOW, brl('75.00'))],
      ['REJECTED', (t) => t.reject(FailureCode.InsufficientFunds, NOW, brl('10.00'))],
      ['FAILED', (t) => t.fail(FailureCode.PermanentProcessingError, NOW)],
    ];
    const transitions: Array<[string, (t: WagerTransaction) => void]> = [
      ['markProcessed', (t) => t.markProcessed(undefined, NOW, brl('1.00'))],
      ['markPendingReference', (t) => t.markPendingReference(NOW, brl('1.00'), referenceRetry)],
      ['reject', (t) => t.reject(FailureCode.CurrencyMismatch, NOW, brl('1.00'))],
      ['fail', (t) => t.fail(FailureCode.PermanentProcessingError, NOW)],
    ];
    const combinations = terminalStates.flatMap(([state, reach]) =>
      transitions.map(([name, transition]) => [state, name, reach, transition] as const),
    );

    it.each(combinations)('%s is terminal: %s throws InvalidTransactionStateError', (_state, _name, reach, transition) => {
      const transaction = wager();
      reach(transaction);

      expect(() => transition(transaction)).toThrow(InvalidTransactionStateError);
      expect(transaction.isTerminal()).toBe(true);
    });

    it('rehydrated terminal state is still terminal', () => {
      const original = wager();
      original.markProcessed(undefined, NOW, brl('75.00'));
      const rehydrated = WagerTransaction.rehydrate({ ...wagerProps(), ...snapshot(original) });

      expect(() => rehydrated.reject(FailureCode.InsufficientFunds, NOW, brl('1.00'))).toThrow(InvalidTransactionStateError);
    });
  });

  describe('reference retries', () => {
    it('each wait counts one attempt and schedules the next one with exponential backoff', () => {
      const transaction = wager({ kind: Refund, referenceExternalTransactionId: 'ext-0' });

      transaction.markPendingReference(NOW, brl('100.00'), referenceRetry);
      expect(transaction.referenceAttempts).toBe(1);
      expect(transaction.nextReferenceAttemptAt).toEqual(later(1_000));

      transaction.markPendingReference(later(1_000), brl('100.00'), referenceRetry);
      expect(transaction.referenceAttempts).toBe(2);
      expect(transaction.nextReferenceAttemptAt).toEqual(later(3_000));
    });

    it('is exhausted after maxAttempts waits', () => {
      const transaction = wager({ kind: Refund, referenceExternalTransactionId: 'ext-0' });

      for (let i = 0; i < referenceRetry.maxAttempts; i++) {
        expect(transaction.hasExhaustedReferenceAttempts(referenceRetry)).toBe(false);
        transaction.markPendingReference(NOW, brl('100.00'), referenceRetry);
      }

      expect(transaction.hasExhaustedReferenceAttempts(referenceRetry)).toBe(true);
    });
  });

  describe('domain queries', () => {
    it('only LOSS does not affect the balance', () => {
      expect(wager({ kind: Loss }).affectsBalance()).toBe(false);
      expect(wager({ kind: Bet }).affectsBalance()).toBe(true);
      expect(wager({ kind: Win }).affectsBalance()).toBe(true);
    });

    it('REFUND and ROLLBACK require a reference', () => {
      expect(wager({ kind: Refund, referenceExternalTransactionId: 'x' }).requiresReference()).toBe(true);
      expect(wager({ kind: Rollback, referenceExternalTransactionId: 'x' }).requiresReference()).toBe(true);
      expect(wager({ kind: Win, referenceExternalTransactionId: 'x' }).requiresReference()).toBe(false);
    });

    it('matchesPayload compares the payload hash', () => {
      const transaction = wager();

      expect(transaction.matchesPayload(transaction.payloadHash)).toBe(true);
      expect(transaction.matchesPayload(wager({ money: brl('26.00') }).payloadHash)).toBe(false);
    });

    it.each([
      ['BET', Bet, undefined, LedgerDirection.Debit],
      ['WIN', Win, undefined, LedgerDirection.Credit],
      ['REFUND', Refund, Bet, LedgerDirection.Credit],
      ['ROLLBACK of a BET', Rollback, Bet, LedgerDirection.Credit],
      ['ROLLBACK of a WIN', Rollback, Win, LedgerDirection.Debit],
      ['ROLLBACK of a REFUND', Rollback, Refund, LedgerDirection.Debit],
    ])('ledger direction of %s', (_case, kind, referenceKind, expected) => {
      const reference = referenceKind
        ? wager({ kind: referenceKind, externalTransactionId: 'ext-0', referenceExternalTransactionId: referenceKind === Bet ? undefined : 'ext-00' })
        : undefined;
      const transaction = wager({ kind, referenceExternalTransactionId: reference ? 'ext-0' : undefined });

      expect(transaction.ledgerDirectionFor(reference)).toBe(expected);
    });

    it('LOSS has no ledger direction, and ROLLBACK needs its reference to have one', () => {
      expect(() => wager({ kind: Loss }).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
      expect(() => wager({ kind: Rollback, referenceExternalTransactionId: 'x' }).ledgerDirectionFor()).toThrow(
        InvalidWagerTransactionError,
      );
    });
  });
});

function snapshot(transaction: WagerTransaction) {
  return {
    payloadHash: transaction.payloadHash,
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId,
    failureCode: transaction.failureCode,
    processedAt: transaction.processedAt,
    resultBalance: transaction.resultBalance,
    referenceAttempts: transaction.referenceAttempts,
    nextReferenceAttemptAt: transaction.nextReferenceAttemptAt,
  };
}
