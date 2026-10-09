import { DeleteMessageCommand, type Message, ReceiveMessageCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { provisionQueues, type QueueNames } from '../../src/infrastructure/messaging/provision-queues';
import { QueueUrls } from '../../src/infrastructure/messaging/queue-urls';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { testEnv } from './test-database';
import { uuid } from './test-app';

export interface TestQueues {
  names: QueueNames;
  /** Env overrides that point an app instance at these queues (short timeouts for tests). */
  env: Record<string, string>;
  sqs: SQSClient;
  send(envelope: unknown, options?: { groupId?: string; deduplicationId?: string; raw?: string }): Promise<void>;
  /** Receives and deletes everything currently visible in a queue. */
  drain(queue: keyof QueueNames): Promise<Message[]>;
  close(): void;
}

/** Fresh FIFO queues per test file, so tests never consume each other's messages. */
export async function createTestQueues(label: string, options: { maxReceiveCount?: number; visibilityTimeoutSeconds?: number } = {}): Promise<TestQueues> {
  const sqs = createSqsClient(testEnv());
  const suffix = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const names: QueueNames = {
    wagerQueue: `wager-${suffix}.fifo`,
    deadLetterQueue: `wager-dlq-${suffix}.fifo`,
    eventsQueue: `events-${suffix}.fifo`,
  };
  const maxReceiveCount = options.maxReceiveCount ?? 3;
  const visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? 2;
  await provisionQueues(sqs, names, { maxReceiveCount, visibilityTimeoutSeconds });
  const urls = new QueueUrls(sqs);

  return {
    names,
    sqs,
    env: {
      SQS_WAGER_QUEUE: names.wagerQueue,
      SQS_WAGER_DLQ: names.deadLetterQueue,
      SQS_EVENTS_QUEUE: names.eventsQueue,
      SQS_MAX_RECEIVE_COUNT: String(maxReceiveCount),
      SQS_VISIBILITY_TIMEOUT_SECONDS: String(visibilityTimeoutSeconds),
      SQS_WAIT_TIME_SECONDS: '1',
    },
    async send(envelope, { groupId, deduplicationId, raw } = {}) {
      const data = (envelope as { data?: { walletId?: string } } | null)?.data;
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: await urls.get(names.wagerQueue),
          MessageBody: raw ?? JSON.stringify(envelope),
          MessageGroupId: groupId ?? data?.walletId ?? 'default',
          // A fresh deduplication id on purpose: tests simulate redeliveries that SQS dedup would hide.
          MessageDeduplicationId: deduplicationId ?? uuid(),
        }),
      );
    },
    async drain(queue) {
      const url = await urls.get(names[queue]);
      const received: Message[] = [];
      for (;;) {
        const { Messages = [] } = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }),
        );
        if (Messages.length === 0) return received;
        for (const message of Messages) {
          received.push(message);
          await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
        }
      }
    },
    close: () => sqs.destroy(),
  };
}

/** A WagerTransactionRequested envelope (§10) for the wallet. */
export function wagerMessage(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  const externalTransactionId = uuid();
  return {
    messageId: `msg-${uuid()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-q',
      externalTransactionId,
      idempotencyKey: `provider-q:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...overrides,
    },
  };
}
