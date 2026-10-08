import type { IntegrationEvent } from '../events/integration-event';
import type { BackoffPolicy } from '../shared/backoff-policy';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

/**
 * An integration event waiting to be published. Enqueued in the same SQL transaction as the change
 * that produced it, so an event exists if and only if that change was committed. The publisher never
 * gives up on a message (confirmed events must not be lost): the backoff only spaces the retries out.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  /** id = eventId, so a re-published event keeps the id consumers deduplicate by. Due immediately. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON(),
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new Error(`outbox message ${this.id} was already published`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Counts a failed publish and schedules the next one (exponential backoff, capped). */
  scheduleRetry(now: Date, policy: BackoffPolicy): void {
    if (!this.isPending()) {
      throw new Error(`outbox message ${this.id} was already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = policy.nextAttemptAt(now, this._attempts);
  }
}
