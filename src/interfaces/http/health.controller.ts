import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Env } from '../../infrastructure/config/env';
import { ENV, SQS_CLIENT } from '../../infrastructure/tokens';

type CheckStatus = 'up' | 'down';

const CHECK_TIMEOUT_MS = 2_000;

/** Health endpoints are intentionally unauthenticated (README §2). */
@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Liveness: the process answers. No dependency checks, so a DB outage does not trigger restarts. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: this instance can do useful work (PostgreSQL and SQS reachable). */
  @Get('ready')
  async ready() {
    const [database, queue] = await Promise.all([this.checkDatabase(), this.checkQueue()]);
    const checks = { database, queue };
    if (database === 'down' || queue === 'down') {
      throw new ServiceUnavailableException({ status: 'unavailable', checks });
    }
    return { status: 'ok', checks };
  }

  /** Runs a real query: MikroORM connects lazily, so `checkConnection()` alone reports "down" before first use. */
  private async checkDatabase(): Promise<CheckStatus> {
    return withTimeout(this.orm.em.getConnection().execute('select 1'), CHECK_TIMEOUT_MS).then(
      () => 'up' as const,
      () => 'down' as const,
    );
  }

  private async checkQueue(): Promise<CheckStatus> {
    const command = new GetQueueUrlCommand({ QueueName: this.env.SQS_WAGER_QUEUE });
    return withTimeout(this.sqs.send(command), CHECK_TIMEOUT_MS).then(
      () => 'up' as const,
      () => 'down' as const,
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}
