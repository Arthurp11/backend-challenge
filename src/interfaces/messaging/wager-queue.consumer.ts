import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';
import {
  ApplicationError,
  ConcurrentModificationError,
  TransientInfrastructureError,
} from '../../application/errors';
import type { ProcessWagerTransaction, WagerTransactionCommand } from '../../application/use-cases/process-wager-transaction';
import { DomainError } from '../../domain/shared/domain-error';
import type { QueueUrls } from '../../infrastructure/messaging/queue-urls';
import { logger, withLogContext } from '../../infrastructure/observability/logger';
import { metrics } from '../../infrastructure/observability/metrics';
import { validate, wagerTransactionBody } from '../http/request-validation';

const envelopeSchema = z.object({
  messageId: z.string().trim().min(1).max(200),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string(),
  data: wagerTransactionBody.extend({ idempotencyKey: z.string().trim().min(1).max(255) }),
});

export interface WagerQueueConsumerOptions {
  consumerName: string;
  queueName: string;
  deadLetterQueueName: string;
  waitTimeSeconds: number;
  maxMessages: number;
  visibilityTimeoutSeconds: number;
  /** How long `stop()` waits for in-flight messages before releasing the rest. */
  shutdownGraceMs: number;
  /** Test seam: SIGKILL the process after the commit and before the ack (§13 concurrency 5). */
  crashAfterCommitBeforeAck: boolean;
}

type Outcome = 'ack' | 'retry' | 'dead-letter';

/**
 * Consumes wager-transactions.fifo with the same use case as HTTP.
 *
 * - The inbox row is written in the same SQL transaction as the financial change; the message is
 *   deleted (ack) only after that commit. A redelivery finds the inbox row and becomes a replay.
 * - Business rejections are results, not errors: they are persisted, so the message is acked.
 * - Transient failures (lock timeout, deadlock, database down): the message is retried later with
 *   exponential backoff on its visibility; after maxReceiveCount the redrive policy moves it to the DLQ.
 * - Permanent failures (malformed message, idempotency/inbox conflict, unknown wallet): sent to the DLQ
 *   right away, with the reason as a message attribute, and acked.
 * - Messages of one MessageGroupId (one wallet) are processed in order; different groups in parallel.
 */
export class WagerQueueConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private poll: AbortController | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly urls: QueueUrls,
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly options: WagerQueueConsumerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** SIGTERM path: stop polling, let in-flight messages finish, release (visibility 0) what did not start. */
  async stop(): Promise<void> {
    this.running = false;
    this.poll?.abort();
    const grace = new Promise((resolve) => setTimeout(resolve, this.options.shutdownGraceMs));
    await Promise.race([this.loop, grace]);
  }

  private async run(): Promise<void> {
    const queueUrl = await this.urls.get(this.options.queueName).catch((error) => {
      logger.error({ err: error }, 'wager queue not reachable, consumer not started');
      return undefined;
    });
    while (this.running && queueUrl) {
      let messages: Message[];
      try {
        this.poll = new AbortController();
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: this.options.maxMessages,
            WaitTimeSeconds: this.options.waitTimeSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.poll.signal },
        );
        messages = response.Messages ?? [];
      } catch (error) {
        if (!this.running) break;
        logger.warn({ err: error }, 'receive failed, backing off');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      await this.processBatch(queueUrl, messages);
    }
  }

  private async processBatch(queueUrl: string, messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (!this.running) {
            await this.release(queueUrl, message);
            continue;
          }
          await this.handle(queueUrl, message);
        }
      }),
    );
  }

  private async handle(queueUrl: string, message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let command: WagerTransactionCommand;
    try {
      command = this.parse(message);
    } catch (error) {
      await this.deadLetter(queueUrl, message, 'INVALID_MESSAGE', error);
      return;
    }

    await withLogContext(
      { messageId: command.message?.messageId, walletId: command.walletId, providerId: command.providerId },
      async () => {
        const started = performance.now();
        const outcome = await this.process(command);
        metrics.processingSeconds.observe({ source: 'sqs' }, (performance.now() - started) / 1_000);
        if (outcome.kind === 'ack') {
          if (this.options.crashAfterCommitBeforeAck) {
            logger.warn('fault injection: crashing after commit, before ack');
            process.kill(process.pid, 'SIGKILL');
          }
          await this.ack(queueUrl, message);
        } else if (outcome.kind === 'dead-letter') {
          await this.deadLetter(queueUrl, message, outcome.reason, outcome.error);
        } else {
          await this.retryLater(queueUrl, message, receiveCount, outcome.error);
        }
      },
    );
  }

  private async process(
    command: WagerTransactionCommand,
  ): Promise<{ kind: 'ack' } | { kind: Exclude<Outcome, 'ack'>; reason: string; error: unknown }> {
    try {
      const result = await this.processWagerTransaction.execute(command);
      metrics.transactions.inc({ status: result.status, kind: command.kind, source: 'sqs' });
      if (result.idempotentReplay) metrics.duplicates.inc({ source: 'sqs' });
      logger.info({ transactionId: result.transactionId, status: result.status, replay: result.idempotentReplay }, 'message processed');
      return { kind: 'ack' };
    } catch (error) {
      if (error instanceof TransientInfrastructureError || error instanceof ConcurrentModificationError) {
        return { kind: 'retry', reason: 'TRANSIENT', error };
      }
      if (error instanceof ApplicationError || error instanceof DomainError) {
        metrics.conflicts.inc({ code: error.code });
        return { kind: 'dead-letter', reason: error.code, error };
      }
      // Unknown: treat as transient. If it keeps failing, the redrive policy dead-letters it.
      return { kind: 'retry', reason: 'UNKNOWN', error };
    }
  }

  private parse(message: Message): WagerTransactionCommand {
    const envelope = validate(envelopeSchema, JSON.parse(message.Body ?? ''), 'message');
    return {
      ...envelope.data,
      correlationId: envelope.messageId,
      message: { consumerName: this.options.consumerName, messageId: envelope.messageId },
    };
  }

  private async ack(queueUrl: string, message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  /** Visibility backoff: 2s, 4s, 8s… capped at 60s. */
  private async retryLater(queueUrl: string, message: Message, receiveCount: number, error: unknown): Promise<void> {
    metrics.retries.inc({ reason: 'queue_redelivery' });
    const delay = Math.min(60, 2 ** receiveCount);
    logger.warn({ err: error, receiveCount, retryInSeconds: delay }, 'transient failure, message will be redelivered');
    await this.sqs
      .send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: delay }))
      .catch((visibilityError) => logger.warn({ err: visibilityError }, 'could not change visibility; default timeout applies'));
  }

  private async deadLetter(queueUrl: string, message: Message, reason: string, error: unknown): Promise<void> {
    metrics.deadLetters.inc({ reason });
    logger.error({ err: error, reason }, 'permanent failure, sending message to the DLQ');
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: await this.urls.get(this.options.deadLetterQueueName),
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letters',
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            failureReason: { DataType: 'String', StringValue: reason },
            failedAt: { DataType: 'String', StringValue: new Date().toISOString() },
          },
        }),
      );
      await this.ack(queueUrl, message);
    } catch (dlqError) {
      // Not acked: the message comes back after its visibility timeout and the redrive policy still applies.
      logger.error({ err: dlqError }, 'could not send to the DLQ; message left for redelivery');
    }
  }

  private async release(queueUrl: string, message: Message): Promise<void> {
    await this.sqs
      .send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }))
      .catch(() => undefined);
  }
}
