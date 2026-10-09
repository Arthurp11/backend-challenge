import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/** Delivers one integration event to the broker. At-least-once: consumers deduplicate by eventId. */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}
