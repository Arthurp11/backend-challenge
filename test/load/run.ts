/**
 * Load test (§14, optional): `bun run test:load` against the Compose stack started with
 * `docker compose up --build -d --scale app=3`. Requests are spread round-robin over the instances.
 *
 * Per scenario it measures throughput, client-side latency percentiles, HTTP statuses, server counters
 * (summed over the instances) and the outbox lag sampled while the load runs.
 * Not a benchmark: the generator, the instances, PostgreSQL and the SQS emulator share one machine.
 * Methodology and results: docs/load-test.md.
 */
import { cpus, totalmem } from 'node:os';

const BASE_URLS = (process.env.LOAD_BASE_URLS ?? 'http://localhost:3000,http://localhost:3001,http://localhost:3002').split(',');
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 64);
// Multiplies every request count, e.g. LOAD_SCALE=5 for a longer run.
const SCALE = Number(process.env.LOAD_SCALE ?? 1);

interface Wallet {
  id: string;
  playerId: string;
}

interface Sample {
  status: number | 'network';
  ms: number;
}

interface ScenarioResult {
  name: string;
  concurrency: number;
  requests: number;
  seconds: number;
  statuses: Record<string, number>;
  latency: { p50: number; p95: number; p99: number; max: number };
  server: Counters;
  outbox: { maxLagSeconds: number; maxPending: number; drainSeconds: number };
}

let nextInstance = 0;
const instanceUrl = () => BASE_URLS[nextInstance++ % BASE_URLS.length]!;

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${instanceUrl()}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function timed(request: () => Promise<Response>): Promise<Sample> {
  const started = performance.now();
  try {
    const response = await request();
    await response.arrayBuffer();
    return { status: response.status, ms: performance.now() - started };
  } catch {
    return { status: 'network', ms: performance.now() - started };
  }
}

/** Keeps `concurrency` requests in flight until every item has been sent. */
async function runPool<T, R>(items: T[], concurrency: number, send: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const item = items[index++]!;
      results.push(await send(item));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function openWallets(count: number, amount = '1000000.00'): Promise<Wallet[]> {
  return runPool(Array.from({ length: count }), CONCURRENCY, async () => {
    const playerId = Bun.randomUUIDv7();
    const response = await post('/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
    if (response.status !== 201) throw new Error(`could not open a wallet: HTTP ${response.status}`);
    const { id } = (await response.json()) as { id: string };
    return { id, playerId };
  });
}

type Kind = 'BET' | 'WIN' | 'LOSS';

interface WagerRequest {
  wallet: Wallet;
  kind: Kind;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function wagerRequest(wallet: Wallet, kind: Kind, amount = '1.00', externalTransactionId = Bun.randomUUIDv7()): WagerRequest {
  const body = {
    providerId: 'load-provider',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${externalTransactionId}`,
    gameId: 'load-game',
    kind,
    money: { amount, currency: 'BRL' },
  };
  return { wallet, kind, body, headers: { 'Idempotency-Key': `load-provider:${externalTransactionId}` } };
}

// ---- server-side metrics (Prometheus text, one registry per instance)

interface Counters {
  processed: number;
  rejected: number;
  duplicates: number;
  retries: number;
  lockConflicts: number;
}

function sumSeries(text: string, name: string, labelFilter = ''): number {
  let total = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const [series, value] = line.split(' ');
    if (series?.split('{')[0] === name && series.includes(labelFilter) && value !== undefined) total += Number(value);
  }
  return total;
}

async function scrapeCounters(): Promise<Counters> {
  const texts = await Promise.all(BASE_URLS.map((url) => fetch(`${url}/metrics`).then((response) => response.text())));
  const sum = (name: string, labelFilter = '') => texts.reduce((total, text) => total + sumSeries(text, name, labelFilter), 0);
  return {
    processed: sum('wager_transactions_total', 'status="PROCESSED"'),
    rejected: sum('wager_transactions_total', 'status="REJECTED"'),
    duplicates: sum('wager_duplicates_detected_total'),
    retries: sum('wager_retries_total'),
    lockConflicts: sum('wager_lock_conflicts_total'),
  };
}

function difference(after: Counters, before: Counters): Counters {
  return {
    processed: after.processed - before.processed,
    rejected: after.rejected - before.rejected,
    duplicates: after.duplicates - before.duplicates,
    retries: after.retries - before.retries,
    lockConflicts: after.lockConflicts - before.lockConflicts,
  };
}

/** The outbox gauges are read from the shared database at scrape time, so one instance is enough. */
async function outboxGauges(): Promise<{ lagSeconds: number; pending: number }> {
  const text = await fetch(`${BASE_URLS[0]}/metrics`).then((response) => response.text());
  return { lagSeconds: sumSeries(text, 'outbox_lag_seconds'), pending: sumSeries(text, 'outbox_pending_messages') };
}

function sampleOutbox(intervalMs = 250) {
  let running = true;
  let maxLagSeconds = 0;
  let maxPending = 0;
  const loop = (async () => {
    while (running) {
      const gauges = await outboxGauges().catch(() => undefined);
      if (gauges) {
        maxLagSeconds = Math.max(maxLagSeconds, gauges.lagSeconds);
        maxPending = Math.max(maxPending, gauges.pending);
      }
      await Bun.sleep(intervalMs);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return { maxLagSeconds, maxPending };
    },
  };
}

/** Seconds until every event of the scenario has been published (the outbox is empty again). */
async function waitOutboxDrained(timeoutMs = 120_000): Promise<number> {
  const started = performance.now();
  while ((await outboxGauges()).pending > 0) {
    if (performance.now() - started > timeoutMs) return Number.POSITIVE_INFINITY;
    await Bun.sleep(100);
  }
  return (performance.now() - started) / 1_000;
}

// ---- scenarios

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

async function runScenario(name: string, requests: WagerRequest[], concurrency = CONCURRENCY): Promise<ScenarioResult> {
  const before = await scrapeCounters();
  const sampler = sampleOutbox();
  const started = performance.now();
  const samples = await runPool(requests, concurrency, (request) =>
    timed(() => post('/wagering/transactions', request.body, request.headers)),
  );
  const seconds = (performance.now() - started) / 1_000;
  const { maxLagSeconds, maxPending } = await sampler.stop();
  const drainSeconds = await waitOutboxDrained();
  const server = difference(await scrapeCounters(), before);

  const statuses: Record<string, number> = {};
  for (const sample of samples) statuses[sample.status] = (statuses[sample.status] ?? 0) + 1;
  const sorted = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  return {
    name,
    concurrency,
    requests: samples.length,
    seconds,
    statuses,
    latency: { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.at(-1) ?? 0 },
    server,
    outbox: { maxLagSeconds, maxPending, drainSeconds },
  };
}

/** Many wallets, no lock contention: BET, BET, WIN, LOSS spread over the wallets and the instances. */
async function distinctWallets(): Promise<ScenarioResult> {
  const wallets = await openWallets(100 * SCALE);
  const kinds: Kind[] = ['BET', 'BET', 'WIN', 'LOSS'];
  const requests = Array.from({ length: 4_000 * SCALE }, (_, i) => wagerRequest(wallets[i % wallets.length]!, kinds[i % kinds.length]!));
  return runScenario('distinct wallets', requests);
}

// ---- report

async function checkReady(): Promise<void> {
  for (const url of BASE_URLS) {
    const ready = await fetch(`${url}/health/ready`).then((response) => response.ok).catch(() => false);
    if (!ready) {
      console.error(`${url} is not ready. Start the stack first: docker compose up --build -d --scale app=3`);
      process.exit(1);
    }
  }
}

const ms = (value: number) => value.toFixed(1);

function report(results: ScenarioResult[]): void {
  console.log(`\nenvironment: ${cpus()[0]?.model} (${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB), Bun ${Bun.version}, ${BASE_URLS.length} instances`);
  console.log('\n| scenario | concurrency | requests | req/s | p50 ms | p95 ms | p99 ms | max ms | statuses | errors (5xx/network) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const result of results) {
    const errors = Object.entries(result.statuses)
      .filter(([status]) => status === 'network' || Number(status) >= 500)
      .reduce((total, [, count]) => total + count, 0);
    const statuses = Object.entries(result.statuses).map(([status, count]) => `${status}: ${count}`).join(', ');
    console.log(
      `| ${result.name} | ${result.concurrency} | ${result.requests} | ${(result.requests / result.seconds).toFixed(0)} | ` +
        `${ms(result.latency.p50)} | ${ms(result.latency.p95)} | ${ms(result.latency.p99)} | ${ms(result.latency.max)} | ` +
        `${statuses} | ${((errors / result.requests) * 100).toFixed(2)}% |`,
    );
  }
  console.log('\n| scenario | processed | rejected | replays | retries | lock conflicts | max outbox lag s | max outbox pending | outbox drain s |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const { name, server, outbox } of results) {
    console.log(
      `| ${name} | ${server.processed} | ${server.rejected} | ${server.duplicates} | ${server.retries} | ${server.lockConflicts} | ` +
        `${outbox.maxLagSeconds.toFixed(2)} | ${outbox.maxPending} | ${outbox.drainSeconds.toFixed(2)} |`,
    );
  }
}

await checkReady();
const results = [await distinctWallets()];
report(results);
