import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './infrastructure/config/env';

const env = loadEnv();
const app = await NestFactory.create(AppModule.register(env));

// SIGTERM/SIGINT run the onModuleDestroy/onApplicationShutdown hooks (consumers drain, pools close).
app.enableShutdownHooks();

await app.listen(env.PORT);
console.log(`[${env.INSTANCE_ID}] listening on :${env.PORT}`);
