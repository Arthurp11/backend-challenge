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

/*
 * Request-level outcomes that are not business rejections: nothing is persisted for them.
 * `code` is the stable machine-readable value returned to clients.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Same idempotency key, different payload: a conflict, never a replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(idempotencyKey: string) {
    super(`idempotency key ${idempotencyKey} was already used with a different payload`);
  }
}

/** The provider's transaction id was already used under another idempotency key. */
export class ExternalIdConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_ID_CONFLICT';

  constructor(providerId: string, externalTransactionId: string) {
    super(`transaction ${externalTransactionId} of ${providerId} already exists under another idempotency key`);
  }
}

/** Same (consumerName, messageId) delivered again with a different payload: a poison message. */
export class InboxPayloadConflictError extends ApplicationError {
  readonly code = 'INBOX_PAYLOAD_CONFLICT';

  constructor(messageId: string) {
    super(`message ${messageId} was already received with a different payload`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(reference: string) {
    super(`transaction ${reference} not found`);
  }
}
