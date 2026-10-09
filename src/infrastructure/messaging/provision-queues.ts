import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';

export interface QueueNames {
  wagerQueue: string;
  deadLetterQueue: string;
  eventsQueue: string;
}

/**
 * Idempotent: CreateQueue with identical attributes returns the existing queue.
 * Content-based deduplication is OFF on purpose: producers always send an explicit
 * MessageDeduplicationId (messageId / eventId), and the database stays the real dedup guarantee.
 */
export async function provisionQueues(
  sqs: SQSClient,
  names: QueueNames,
  options: { maxReceiveCount: number; visibilityTimeoutSeconds: number },
): Promise<void> {
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: String(options.visibilityTimeoutSeconds) };
  const create = async (name: string, attributes: Record<string, string>) => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
    if (!QueueUrl) throw new Error(`CreateQueue returned no URL for ${name}`);
    return QueueUrl;
  };

  const dlqUrl = await create(names.deadLetterQueue, fifo);
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const dlqArn = Attributes?.QueueArn;
  if (!dlqArn) throw new Error('DLQ has no QueueArn');

  await create(names.wagerQueue, {
    ...fifo,
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: options.maxReceiveCount }),
  });
  await create(names.eventsQueue, fifo);
}
