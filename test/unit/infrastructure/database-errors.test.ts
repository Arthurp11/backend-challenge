import { describe, expect, it } from 'bun:test';
import { IdempotencyConflictError, TransientInfrastructureError } from '../../../src/application/errors';
import { translateDatabaseError } from '../../../src/infrastructure/persistence/database-errors';

describe('translateDatabaseError', () => {
  it('never reclassifies an application error, whatever text the client put in it', () => {
    // The key is client input: "connection error" in it must not turn a 409 into a retryable 503.
    const conflict = new IdempotencyConflictError('provider-a:connection error 42');

    expect(translateDatabaseError(conflict)).toBe(conflict);
  });

  it('still classifies a real driver connection failure as transient', () => {
    expect(translateDatabaseError(new Error('Connection terminated unexpectedly'))).toBeInstanceOf(TransientInfrastructureError);
  });
});
