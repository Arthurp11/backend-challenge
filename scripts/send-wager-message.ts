import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadEnv } from '../src/infrastructure/config/env';
import { QueueUrls } from '../src/infrastructure/messaging/queue-urls';
import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

/**
 * Demo helper: publishes one WagerTransactionRequested message (§10) to the wager queue.
 * usage: bun run sqs:send <walletId> <playerId> [kind=BET] [amount=10.00] [referenceExternalTransactionId]
 */
const [walletId, playerId, kind = 'BET', amount = '10.00', referenceExternalTransactionId] = process.argv.slice(2);
if (!walletId || !playerId) {
  console.error('usage: bun run sqs:send <walletId> <playerId> [kind] [amount] [referenceExternalTransactionId]');
  process.exit(1);
}

const env = loadEnv();
const sqs = createSqsClient(env);
const externalTransactionId = `demo-${Bun.randomUUIDv7()}`;
const message = {
  messageId: `msg-${Bun.randomUUIDv7()}`,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: 'round-demo',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(referenceExternalTransactionId && { referenceExternalTransactionId }),
  },
};

await sqs.send(
  new SendMessageCommand({
    QueueUrl: await new QueueUrls(sqs).get(env.SQS_WAGER_QUEUE),
    MessageBody: JSON.stringify(message),
    MessageGroupId: walletId,
    MessageDeduplicationId: message.messageId,
  }),
);
console.log(JSON.stringify(message, null, 2));
sqs.destroy();
