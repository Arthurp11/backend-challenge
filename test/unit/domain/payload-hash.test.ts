import { describe, expect, it } from 'bun:test';
import { canonicalJson } from '../../../src/domain/wagering/payload-hash';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction';
import { brl, later, usd, wager } from '../../support/domain-builders';

describe('payload hash', () => {
  it('is a deterministic sha256 hex: the same request always hashes the same', () => {
    expect(wager().payloadHash).toBe(wager().payloadHash);
    expect(wager().payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses the normalized amount: "25" and "25.00" are the same request', () => {
    expect(wager({ money: brl('25') }).payloadHash).toBe(wager({ money: brl('25.00') }).payloadHash);
  });

  it('ignores the idempotency key, the internal id and the arrival time (transport, not business)', () => {
    const original = wager();
    const resent = wager({ id: 'tx-other', idempotencyKey: 'another-key', createdAt: later(5_000) });

    expect(resent.payloadHash).toBe(original.payloadHash);
  });

  it.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'ext-2' }],
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: 'wallet-2' }],
    ['roundId', { roundId: 'round-2' }],
    ['gameId', { gameId: 'other-game' }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['amount', { money: brl('25.01') }],
    ['currency', { money: usd('25.00') }],
  ])('changes when %s changes', (_field, overrides) => {
    expect(wager(overrides).payloadHash).not.toBe(wager().payloadHash);
  });

  it('changes when a reference is added', () => {
    const win = wager({ kind: WagerTransactionKind.Win });
    const winWithReference = wager({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'bet-1' });

    expect(winWithReference.payloadHash).not.toBe(win.payloadHash);
  });

  describe('canonicalJson', () => {
    it('sorts keys at every level', () => {
      const a = canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } });
      const b = canonicalJson({ a: { c: 'x', d: [1, { y: 2, z: 1 }] }, b: 1 });

      expect(a).toBe(b);
      expect(a).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
    });

    it('keeps array order (order is meaningful in arrays)', () => {
      expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    });

    it('drops undefined fields and keeps null', () => {
      expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    });
  });
});
