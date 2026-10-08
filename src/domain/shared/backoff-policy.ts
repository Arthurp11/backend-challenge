/**
 * Exponential backoff with a cap and an attempt limit. Shared by the outbox publisher and the
 * pending-reference worker. Deterministic on purpose (no jitter), so retries are testable.
 */
export class BackoffPolicy {
  private constructor(
    public readonly baseDelayMs: number,
    public readonly maxDelayMs: number,
    public readonly maxAttempts: number,
  ) {}

  static exponential(props: { baseDelayMs: number; maxDelayMs: number; maxAttempts: number }): BackoffPolicy {
    const { baseDelayMs, maxDelayMs, maxAttempts } = props;
    if (!isPositiveInteger(baseDelayMs) || !isPositiveInteger(maxDelayMs) || !isPositiveInteger(maxAttempts)) {
      throw new RangeError('backoff values must be positive integers');
    }
    if (baseDelayMs > maxDelayMs) {
      throw new RangeError('baseDelayMs cannot be greater than maxDelayMs');
    }
    return new BackoffPolicy(baseDelayMs, maxDelayMs, maxAttempts);
  }

  /** Delay before the next try, after `attempts` failed tries: base, 2×base, 4×base… capped at maxDelayMs. */
  delayAfter(attempts: number): number {
    const exponent = Math.max(0, attempts - 1);
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** exponent);
  }

  nextAttemptAt(now: Date, attempts: number): Date {
    return new Date(now.getTime() + this.delayAfter(attempts));
  }

  isExhausted(attempts: number): boolean {
    return attempts >= this.maxAttempts;
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
