import { TransientInfrastructureError, UniqueViolationError } from '../../application/errors';
import { DomainError } from '../../domain/shared/domain-error';

/** SQLSTATEs that mean "try again later", not "this request is wrong". */
const TRANSIENT_SQLSTATES: Readonly<Record<string, string>> = {
  '40001': 'serialization failure',
  '40P01': 'deadlock detected',
  '55P03': 'lock timeout',
  '57014': 'statement timeout',
  '25P03': 'idle in transaction timeout',
  '53300': 'too many connections',
  '57P01': 'database shutting down',
  '57P02': 'database crash shutdown',
  '57P03': 'database starting up',
};

/** Socket-level failures reported by the driver before any SQLSTATE exists. */
const TRANSIENT_SYSTEM_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
const TRANSIENT_MESSAGES = /connection terminated|timeout exceeded when trying to connect|connection error/i;

/**
 * Translates driver errors (MikroORM copies the pg error's `code` and `constraint`) into application
 * errors. Domain errors and unknown errors pass through untouched.
 */
export function translateDatabaseError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof DomainError) {
    return error;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (code === '23505') {
    return new UniqueViolationError(typeof constraint === 'string' ? constraint : undefined, { cause: error });
  }
  if (typeof code === 'string') {
    const reason = TRANSIENT_SQLSTATES[code];
    if (reason) return new TransientInfrastructureError(reason, { cause: error });
    if (code.startsWith('08')) return new TransientInfrastructureError('connection failure', { cause: error });
    if (TRANSIENT_SYSTEM_CODES.has(code)) return new TransientInfrastructureError(`network: ${code}`, { cause: error });
  }
  if (TRANSIENT_MESSAGES.test(error.message)) {
    return new TransientInfrastructureError('connection failure', { cause: error });
  }
  return error;
}
