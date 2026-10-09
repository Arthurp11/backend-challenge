/*
 * Infrastructure failures, translated into terms the use cases can act on. The classification decides
 * what happens next: retry (transient), replay or conflict (unique violation), or give up (anything else).
 */

/** A unique constraint was violated: another transaction committed the same key first. */
export class UniqueViolationError extends Error {
  constructor(
    public readonly constraint: string | undefined,
    options?: ErrorOptions,
  ) {
    super(`unique constraint violated: ${constraint ?? 'unknown'}`, options);
    this.name = 'UniqueViolationError';
  }
}

/** The row changed between read and write. Should not happen while the row lock is held. */
export class ConcurrentModificationError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was modified concurrently`);
    this.name = 'ConcurrentModificationError';
  }
}

/** Worth retrying later: lock timeout, deadlock, serialization failure, lost connection, timeouts. */
export class TransientInfrastructureError extends Error {
  constructor(
    public readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`transient infrastructure failure: ${reason}`, options);
    this.name = 'TransientInfrastructureError';
  }
}
