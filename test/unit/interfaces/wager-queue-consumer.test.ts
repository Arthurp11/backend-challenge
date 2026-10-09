import { describe, expect, it } from 'bun:test';
import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import { TransientInfrastructureError } from '../../../src/application/errors';
import type { ProcessWagerTransaction, WagerTransactionCommand } from '../../../src/application/use-cases/process-wager-transaction';
import type { QueueUrls } from '../../../src/infrastructure/messaging/queue-urls';
import { WagerQueueConsumer } from '../../../src/interfaces/messaging/wager-queue.consumer';
import { eventually } from '../../support/eventually';

/**
 * Control flow of the consumer around SQS failures that MiniStack cannot inject on demand (a failing
 * DeleteMessage). The end-to-end behaviour against the real queue is in test/integration/consumer.test.ts.
 */
class FakeSqs {
  readonly calls: string[] = [];

  constructor(
    private readonly batches: Message[][],
    private readonly options: { failDelete?: boolean } = {},
  ) {}

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }) {
    const handle = command.input.ReceiptHandle;
    switch (command.constructor.name) {
      case 'ReceiveMessageCommand': {
        const batch = this.batches.shift();
        if (batch) return { Messages: batch };
        // Long poll with nothing left: wait until the consumer stops.
        return new Promise((_, reject) => options?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      case 'DeleteMessageCommand':
        this.calls.push(`delete ${handle}`);
        if (this.options.failDelete) throw new Error('SQS unavailable');
        return {};
      case 'ChangeMessageVisibilityCommand':
        this.calls.push(`visibility ${handle} ${command.input.VisibilityTimeout}`);
        return {};
      default:
        this.calls.push(command.constructor.name);
        return {};
    }
  }
}

function message(id: string, walletId: string): Message {
  const data = {
    providerId: 'provider-a',
    externalTransactionId: id,
    idempotencyKey: `provider-a:${id}`,
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
  };
  return {
    ReceiptHandle: id,
    MessageId: `sqs-${id}`,
    Body: JSON.stringify({ messageId: `msg-${id}`, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data }),
    Attributes: { MessageGroupId: walletId, ApproximateReceiveCount: '1' },
  };
}

function startConsumer(sqs: FakeSqs, execute: (command: WagerTransactionCommand) => Promise<unknown>) {
  const consumer = new WagerQueueConsumer(
    sqs as unknown as SQSClient,
    { get: async (name: string) => `url:${name}` } as unknown as QueueUrls,
    { execute } as unknown as ProcessWagerTransaction,
    {
      consumerName: 'test',
      queueName: 'wager',
      deadLetterQueueName: 'dlq',
      waitTimeSeconds: 0,
      maxMessages: 10,
      visibilityTimeoutSeconds: 30,
      shutdownGraceMs: 1_000,
      crashAfterCommitBeforeAck: false,
    },
  );
  consumer.start();
  return consumer;
}

const processed = (command: WagerTransactionCommand) => ({
  transactionId: command.externalTransactionId,
  status: 'PROCESSED',
  idempotentReplay: false,
});

const WALLET_A = '0192f291-27dd-7d3f-8071-5f8685deef37';
const WALLET_B = '0192f291-27dd-7d3f-8071-5f8685deef38';

describe('wager queue consumer: SQS failures', () => {
  it('survives a failed ack: the message is left for redelivery and the loop keeps consuming', async () => {
    const sqs = new FakeSqs([[message('m1', WALLET_A)], [message('m2', WALLET_B)]], { failDelete: true });
    const executed: string[] = [];
    const consumer = startConsumer(sqs, async (command) => {
      executed.push(command.externalTransactionId);
      return processed(command);
    });

    await eventually(async () => expect(executed).toEqual(['m1', 'm2']), 2_000, 10);
    await consumer.stop();

    expect(sqs.calls).toEqual(['delete m1', 'delete m2']);
  });

  it('keeps wallet order: after a transient failure, the rest of that wallet group is released, not processed', async () => {
    const sqs = new FakeSqs([[message('m1', WALLET_A), message('m2', WALLET_A), message('m3', WALLET_B)]]);
    const executed: string[] = [];
    const consumer = startConsumer(sqs, async (command) => {
      executed.push(command.externalTransactionId);
      if (command.externalTransactionId === 'm1') throw new TransientInfrastructureError('lock timeout');
      return processed(command);
    });

    await eventually(async () => expect(sqs.calls).toHaveLength(3), 2_000, 10);
    await consumer.stop();

    // m2 waits behind m1 (visibility 0, so FIFO hands it out again only after m1); wallet B is unaffected.
    expect(executed.sort()).toEqual(['m1', 'm3']);
    expect(sqs.calls.sort()).toEqual(['delete m3', 'visibility m1 2', 'visibility m2 0']);
  });
});
