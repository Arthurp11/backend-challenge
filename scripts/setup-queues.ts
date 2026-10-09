import { loadEnv } from '../src/infrastructure/config/env';
import { provisionQueues } from '../src/infrastructure/messaging/provision-queues';
import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

const env = loadEnv();
const sqs = createSqsClient(env);
const names = { wagerQueue: env.SQS_WAGER_QUEUE, deadLetterQueue: env.SQS_WAGER_DLQ, eventsQueue: env.SQS_EVENTS_QUEUE };

await provisionQueues(sqs, names, {
  maxReceiveCount: env.SQS_MAX_RECEIVE_COUNT,
  visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
});
console.log(`queues ready: ${Object.values(names).join(', ')}`);
sqs.destroy();
