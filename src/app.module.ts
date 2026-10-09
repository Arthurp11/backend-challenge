import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import type { MikroORM as PostgresMikroORM } from '@mikro-orm/postgresql';
import { type DynamicModule, Inject, type MiddlewareConsumer, Module, type NestModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { Clock } from './application/ports/clock';
import type { IdGenerator } from './application/ports/id-generator';
import type { UnitOfWork } from './application/ports/unit-of-work';
import { WageringQueries } from './application/queries/wagering-queries';
import { WalletLedgerQueries } from './application/queries/wallet-ledger-queries';
import { CreateWallet } from './application/use-cases/create-wallet';
import { ProcessWagerTransaction } from './application/use-cases/process-wager-transaction';
import { PublishOutbox } from './application/use-cases/publish-outbox';
import { ResolvePendingReferences } from './application/use-cases/resolve-pending-references';
import { BackoffPolicy } from './domain/shared/backoff-policy';
import type { Env } from './infrastructure/config/env';
import { QueueUrls } from './infrastructure/messaging/queue-urls';
import { createSqsClient } from './infrastructure/messaging/sqs-client';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { logger } from './infrastructure/observability/logger';
import { metrics } from './infrastructure/observability/metrics';
import { buildOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { BackgroundWorkers, type BackgroundWorker } from './infrastructure/runtime/background-workers';
import { PollingLoop } from './infrastructure/runtime/polling-loop';
import { SystemClock } from './infrastructure/runtime/system-clock';
import { UuidV7Generator } from './infrastructure/runtime/uuid-v7-generator';
import { CLOCK, ENV, ID_GENERATOR, SQS_CLIENT, UNIT_OF_WORK } from './infrastructure/tokens';
import { HealthController } from './interfaces/http/health.controller';
import { HttpErrorFilter } from './interfaces/http/http-error.filter';
import { MetricsController } from './interfaces/http/metrics.controller';
import { RequestContextMiddleware } from './interfaces/http/request-context.middleware';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';
import { WagerQueueConsumer } from './interfaces/messaging/wager-queue.consumer';

export function referenceRetryPolicy(env: Env): BackoffPolicy {
  return BackoffPolicy.exponential({
    baseDelayMs: env.REFERENCE_RETRY_BASE_MS,
    maxDelayMs: env.REFERENCE_RETRY_MAX_MS,
    maxAttempts: env.REFERENCE_RETRY_MAX_ATTEMPTS,
  });
}

interface WorkerDependencies {
  env: Env;
  uow: UnitOfWork;
  clock: Clock;
  ids: IdGenerator;
  sqs: SQSClient;
  urls: QueueUrls;
  processWagerTransaction: ProcessWagerTransaction;
}

/** Every instance runs every role unless a RUN_* flag turns it off. */
function buildWorkers({ env, uow, clock, ids, sqs, urls, processWagerTransaction }: WorkerDependencies): BackgroundWorker[] {
  const workers: BackgroundWorker[] = [];
  const logFailure = (name: string) => (error: unknown) => logger.error({ err: error, worker: name }, 'background worker iteration failed');

  if (env.RUN_PENDING_REFERENCE_WORKER) {
    const resolve = new ResolvePendingReferences(uow, clock, ids, {
      referenceRetry: referenceRetryPolicy(env),
      batchSize: env.PENDING_REFERENCE_BATCH_SIZE,
    });
    const loop = new PollingLoop(
      env.PENDING_REFERENCE_POLL_MS,
      async () => {
        const { examined, resolved } = await resolve.runOnce();
        for (const status of resolved) metrics.pendingReferenceResolutions.inc({ status });
        return examined === env.PENDING_REFERENCE_BATCH_SIZE;
      },
      logFailure('pending-references'),
    );
    workers.push({ name: 'pending-references', start: () => loop.start(), stop: () => loop.stop() });
  }

  if (env.RUN_OUTBOX_PUBLISHER) {
    const crashAfterPublish = env.FAULT_INJECTION === 'crash_after_publish_before_mark';
    const publish = new PublishOutbox(uow, new SqsEventPublisher(sqs, urls, env.SQS_EVENTS_QUEUE), clock, {
      batchSize: env.OUTBOX_BATCH_SIZE,
      retry: BackoffPolicy.exponential({ baseDelayMs: env.OUTBOX_RETRY_BASE_MS, maxDelayMs: env.OUTBOX_RETRY_MAX_MS, maxAttempts: Number.MAX_SAFE_INTEGER }),
      afterPublish: crashAfterPublish
        ? () => {
            logger.warn('fault injection: crashing after publish, before marking the outbox row');
            process.kill(process.pid, 'SIGKILL');
          }
        : undefined,
    });
    const loop = new PollingLoop(
      env.OUTBOX_POLL_MS,
      async () => {
        const { claimed, published, failed } = await publish.runOnce();
        metrics.outboxPublished.inc(published);
        metrics.outboxPublishFailures.inc(failed);
        return claimed === env.OUTBOX_BATCH_SIZE && failed === 0;
      },
      logFailure('outbox-publisher'),
    );
    workers.push({ name: 'outbox-publisher', start: () => loop.start(), stop: () => loop.stop() });
  }

  if (env.RUN_CONSUMER) {
    const consumer = new WagerQueueConsumer(sqs, urls, processWagerTransaction, {
      consumerName: env.CONSUMER_NAME,
      queueName: env.SQS_WAGER_QUEUE,
      deadLetterQueueName: env.SQS_WAGER_DLQ,
      waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
      maxMessages: env.SQS_MAX_MESSAGES,
      visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
      shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
      crashAfterCommitBeforeAck: env.FAULT_INJECTION === 'crash_after_commit_before_ack',
    });
    workers.push({ name: 'wager-consumer', start: () => consumer.start(), stop: () => consumer.stop() });
  }
  return workers;
}

@Module({})
export class AppModule implements NestModule, OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  /**
   * Env is passed in (not read globally) so tests can boot isolated instances with their own config.
   * Use cases are plain classes (no Nest decorators): they are wired here with factories.
   */
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(buildOrmConfig(env))],
      controllers: [HealthController, MetricsController, WalletsController, WageringController],
      providers: [
        { provide: ENV, useValue: env },
        { provide: SQS_CLIENT, useFactory: (e: Env) => createSqsClient(e), inject: [ENV] },
        { provide: QueueUrls, useFactory: (sqs: SQSClient) => new QueueUrls(sqs), inject: [SQS_CLIENT] },
        { provide: CLOCK, useValue: new SystemClock() },
        { provide: ID_GENERATOR, useValue: new UuidV7Generator() },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
        {
          provide: UNIT_OF_WORK,
          useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm as PostgresMikroORM),
          inject: [MikroORM],
        },
        {
          provide: ProcessWagerTransaction,
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
            new ProcessWagerTransaction(uow, clock, ids, {
              referenceRetry: referenceRetryPolicy(env),
              transientRetries: env.TRANSIENT_RETRIES,
              onTransientRetry: (error) => metrics.retries.inc({ reason: error.reason }),
            }),
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
        },
        {
          provide: CreateWallet,
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new CreateWallet(uow, clock, ids),
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
        },
        { provide: WageringQueries, useFactory: (uow: UnitOfWork) => new WageringQueries(uow), inject: [UNIT_OF_WORK] },
        { provide: WalletLedgerQueries, useFactory: (uow: UnitOfWork) => new WalletLedgerQueries(uow), inject: [UNIT_OF_WORK] },
        {
          provide: BackgroundWorkers,
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, sqs: SQSClient, urls: QueueUrls, process: ProcessWagerTransaction) =>
            new BackgroundWorkers(buildWorkers({ env, uow, clock, ids, sqs, urls, processWagerTransaction: process })),
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, SQS_CLIENT, QueueUrls, ProcessWagerTransaction],
        },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
