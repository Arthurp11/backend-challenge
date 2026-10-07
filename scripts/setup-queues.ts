import { CreateQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { loadEnv } from '../src/infrastructure/config/env';
import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

/**
 * Idempotent: CreateQueue with identical attributes returns the existing queue.
 * Content-based deduplication is OFF on purpose: producers always send an explicit
 * MessageDeduplicationId (messageId / eventId), and the database stays the real dedup guarantee.
 */
const env = loadEnv();
const sqs = createSqsClient(env);

const fifo = {
  FifoQueue: 'true',
  ContentBasedDeduplication: 'false',
  VisibilityTimeout: String(env.SQS_VISIBILITY_TIMEOUT_SECONDS),
};

async function createQueue(name: string, attributes: Record<string, string>): Promise<string> {
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  if (!QueueUrl) throw new Error(`CreateQueue returned no URL for ${name}`);
  console.log(`queue ready: ${name}`);
  return QueueUrl;
}

const dlqUrl = await createQueue(env.SQS_WAGER_DLQ, fifo);
const { Attributes } = await sqs.send(
  new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
);
const dlqArn = Attributes?.QueueArn;
if (!dlqArn) throw new Error('DLQ has no QueueArn');

await createQueue(env.SQS_WAGER_QUEUE, {
  ...fifo,
  RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: env.SQS_MAX_RECEIVE_COUNT }),
});
await createQueue(env.SQS_EVENTS_QUEUE, fifo);

sqs.destroy();
