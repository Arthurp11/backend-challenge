import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { testEnv, useTestDatabase } from './test-database';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export interface TestApp {
  url: string;
  close(): Promise<void>;
  post<T = any>(path: string, body: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>>;
  get<T = any>(path: string): Promise<ApiResponse<T>>;
}

/** Boots the real Nest application (real PostgreSQL, real HTTP) on a random port. */
export async function startTestApp(envOverrides: Record<string, string> = {}): Promise<TestApp> {
  await useTestDatabase();
  const app = await NestFactory.create(AppModule.register(testEnv(envOverrides)), { logger: false });
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  return {
    url,
    close: () => app.close(),
    post: (path, body, headers = {}) => request(`${url}${path}`, { method: 'POST', body: JSON.stringify(body), headers }),
    get: (path) => request(`${url}${path}`, { method: 'GET' }),
  };
}

async function request(url: string, init: { method: string; body?: string; headers?: Record<string, string> }) {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

export const uuid = () => Bun.randomUUIDv7();

export async function createWallet(app: TestApp, amount = '100.00', currency = 'BRL'): Promise<{ id: string; playerId: string }> {
  const response = await app.post('/wallets', { playerId: uuid(), initialBalance: { amount, currency } });
  if (response.status !== 201) {
    throw new Error(`wallet creation failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

/** A BET body for the wallet; override any field. The idempotency key follows the recommended default. */
export function wagerRequest(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  const body = {
    providerId: 'provider-a',
    externalTransactionId: uuid(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
  return { body, headers: { 'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}` } };
}
