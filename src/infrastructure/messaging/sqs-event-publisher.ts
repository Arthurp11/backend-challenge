import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports/event-publisher';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { QueueUrls } from './queue-urls';

/**
 * Publishes to the events FIFO queue. MessageGroupId = walletId keeps the send order per wallet (best
 * effort overall: see ARCHITECTURE D10); MessageDeduplicationId = eventId lets SQS drop a re-publish inside its 5-minute window
 * (an optimization: consumers still deduplicate by eventId). Each call has a hard timeout, because it
 * runs while the outbox rows are locked.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly urls: QueueUrls,
    private readonly queueName: string,
    private readonly timeoutMs = 3_000,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.urls.get(this.queueName),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
      }),
      { abortSignal: AbortSignal.timeout(this.timeoutMs) },
    );
  }
}
