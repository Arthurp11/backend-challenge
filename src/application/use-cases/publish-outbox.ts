import type { BackoffPolicy } from '../../domain/shared/backoff-policy';
import type { Clock } from '../ports/clock';
import type { EventPublisher } from '../ports/event-publisher';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface PublishOutboxOptions {
  batchSize: number;
  retry: BackoffPolicy;
  /** Test seam: runs after a message reached the broker and before it is marked published. */
  afterPublish?: () => void;
}

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Publishes committed events (transactional outbox, §11). Messages are claimed with FOR UPDATE SKIP
 * LOCKED, so concurrent publishers on any number of instances take disjoint slices.
 *
 * If the process dies after the broker accepted a message but before the commit, the row is still
 * unpublished and another publisher sends it again: delivery is at-least-once, and consumers
 * deduplicate by eventId (also the FIFO MessageDeduplicationId).
 */
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly options: PublishOutboxOptions,
  ) {}

  async runOnce(): Promise<PublishOutboxResult> {
    return this.uow.run(async ({ outbox }) => {
      const claimed = await outbox.claimDue(this.clock.now(), this.options.batchSize);
      let published = 0;
      for (const message of claimed) {
        try {
          await this.publisher.publish(message);
        } catch (error) {
          message.scheduleRetry(this.clock.now(), this.options.retry);
          await outbox.save(message, error instanceof Error ? error.message : String(error));
          continue;
        }
        // Outside the try: a database error here surfaces as itself and rolls the batch back (republished later).
        this.options.afterPublish?.();
        message.markPublished(this.clock.now());
        await outbox.save(message);
        published += 1;
      }
      return { claimed: claimed.length, published, failed: claimed.length - published };
    });
  }
}
