import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './infrastructure/config/env';
import { logger } from './infrastructure/observability/logger';

const env = loadEnv();
const app = await NestFactory.create(AppModule.register(env), { logger: ['error', 'warn'] });

// SIGTERM/SIGINT run the shutdown hooks: workers drain first, then HTTP and the pools close.
app.enableShutdownHooks();

await app.listen(env.PORT);
logger.info({ port: env.PORT }, 'listening');
