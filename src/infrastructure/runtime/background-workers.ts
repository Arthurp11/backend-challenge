import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';

export interface BackgroundWorker {
  readonly name: string;
  start(): void;
  /** Resolves once the work in progress has finished (or been released). */
  stop(): Promise<void>;
}

/**
 * Starts the queue consumer, the outbox publisher and the pending-reference worker when the app boots,
 * and stops them before the HTTP server and the database pool close (SIGTERM → drain → close).
 */
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(private readonly workers: BackgroundWorker[]) {}

  onApplicationBootstrap(): void {
    for (const worker of this.workers) {
      worker.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.stop()));
  }
}
