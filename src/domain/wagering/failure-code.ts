/**
 * Stable, machine-readable reasons a transaction ends REJECTED (business rule) or FAILED
 * (permanent infrastructure error). Providers decide on these codes, never on messages,
 * so values are part of the public contract: add new ones, never rename.
 */
export enum FailureCode {
  /** BET larger than the balance. Provider may retry later with a new transaction. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK of a credit (WIN/REFUND) that the player already spent. Needs manual handling. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  /** Referenced transaction never arrived within the retry window. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Reference exists but belongs to another provider, player, wallet, currency or round. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** REFUND must reference a BET; ROLLBACK a BET, WIN or REFUND; WIN/LOSS a BET. */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** Partial reversals are out of scope: the amount must equal the reference's. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Reference ended REJECTED or FAILED, so there is nothing to reverse or settle. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Reference was already reversed by a REFUND or ROLLBACK. */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** FAILED: permanent infrastructure error, kept for audit. */
  PermanentProcessingError = 'PERMANENT_PROCESSING_ERROR',
}
