import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { TEST_ENV_DEFAULTS, testDatabaseUrl } from './test-database';

const PROJECT_ROOT = resolve(import.meta.dir, '../..');

export interface Instance {
  url: string;
  port: number;
  process: Subprocess;
  /** Resolves with the exit code (null when killed by a signal). */
  exited: Promise<number | null>;
  stop(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  get(path: string): Promise<{ status: number; body: any }>;
}

/**
 * Starts a real, separate application process (`bun run src/main.ts`) against the test database:
 * real multi-instance concurrency, real crashes (SIGKILL) and real restarts. Logs go to temp/.
 */
export async function spawnInstance(
  env: Record<string, string> = {},
  options: { waitUntilLive?: boolean } = {},
): Promise<Instance> {
  const port = await freePort();
  const child = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...TEST_ENV_DEFAULTS,
      LOG_LEVEL: 'info',
      DATABASE_URL: testDatabaseUrl(),
      PORT: String(port),
      INSTANCE_ID: `test-instance-${port}`,
      ...env,
    },
    stdout: Bun.file(resolve(PROJECT_ROOT, `temp/instance-${port}.log`)),
    stderr: 'inherit',
  });
  const url = `http://127.0.0.1:${port}`;
  const exited = child.exited.then(() => child.exitCode);
  // A process meant to crash may die before it ever answers the health check.
  if (options.waitUntilLive ?? true) {
    await waitUntilLive(url, exited);
  }

  const call = async (path: string, init: RequestInit) => {
    const response = await fetch(`${url}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };

  return {
    url,
    port,
    process: child,
    exited,
    async stop(signal = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
      await exited;
    },
    post: (path, body, headers = {}) => call(path, { method: 'POST', body: JSON.stringify(body), headers }),
    get: (path) => call(path, { method: 'GET' }),
  };
}

async function waitUntilLive(url: string, exited: Promise<number | null>): Promise<void> {
  let dead = false;
  void exited.then(() => (dead = true));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (dead) throw new Error(`instance at ${url} exited during startup (see temp/instance-*.log)`);
    try {
      if ((await fetch(`${url}/health/live`)).ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(100);
  }
  throw new Error(`instance at ${url} did not become live in time`);
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}
