import { createHash } from 'node:crypto';
import type { Money } from '../money/money';

/** Business fields of a wager request. Transport data (idempotency key, messageId, headers) stays out. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string | undefined;
  gameId: string | undefined;
  kind: string;
  money: Money;
  referenceExternalTransactionId: string | undefined;
}

/**
 * sha256 (hex) of the canonical JSON of the business fields: keys sorted at every level, money
 * normalized to scale 2 ("25" and "25.00" hash the same) and absent optional fields as `null`.
 * Same request through HTTP or SQS => same hash.
 */
export function wagerPayloadHash(payload: WagerPayload): string {
  const canonical = canonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId ?? null,
    gameId: payload.gameId ?? null,
    kind: payload.kind,
    money: payload.money.toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** JSON with object keys sorted recursively, so logically equal objects serialize identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
