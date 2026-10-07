import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Env } from './infrastructure/config/env';
import { createSqsClient } from './infrastructure/messaging/sqs-client';
import { buildOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { ENV, SQS_CLIENT } from './infrastructure/tokens';
import { HealthController } from './interfaces/http/health.controller';

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  /** Env is passed in (not read globally) so tests can boot isolated instances with their own config. */
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(buildOrmConfig(env))],
      controllers: [HealthController],
      providers: [
        { provide: ENV, useValue: env },
        { provide: SQS_CLIENT, useFactory: (e: Env) => createSqsClient(e), inject: [ENV] },
      ],
    };
  }

  onApplicationShutdown() {
    this.sqs.destroy();
  }
}
