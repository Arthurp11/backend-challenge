import { z } from 'zod';
import { ApplicationError } from '../../application/errors';

/** Malformed request (shape, types, required header). Detailed money rules are enforced by Money itself. */
export class RequestValidationError extends ApplicationError {
  readonly code = 'INVALID_REQUEST';

  constructor(
    message: string,
    public readonly issues: ReadonlyArray<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

export function validate<T>(schema: z.ZodType<T>, value: unknown, what = 'body'): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    throw new RequestValidationError(`invalid ${what}`, issues);
  }
  return parsed.data;
}

const text = (max: number) => z.string().trim().min(1).max(max);
/** Money arrives as { amount: string, currency: string }; Money.from rejects NaN, exponents, >2 decimals… */
const money = z.strictObject({ amount: z.string(), currency: z.string() });

export const createWalletBody = z.strictObject({
  playerId: z.uuid(),
  initialBalance: money,
});

/** OPENING is internal: it is simply not in the list of kinds a provider may send. */
export const wagerTransactionBody = z.strictObject({
  providerId: text(100),
  externalTransactionId: text(200),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: text(200),
  gameId: text(200),
  kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money,
  referenceExternalTransactionId: text(200).optional(),
});

export const idempotencyKeyHeader = z.string({ error: 'the Idempotency-Key header is required' }).trim().min(1).max(255);
export const uuidParam = z.uuid();
export const textParam = text(200);

export const ledgerQuery = z.strictObject({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
