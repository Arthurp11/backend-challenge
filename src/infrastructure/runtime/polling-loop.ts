/**
 * Runs `tick` repeatedly: immediately again while it reports more work, otherwise after `intervalMs`.
 * `stop()` wakes the loop up and resolves once the tick in progress has finished (graceful shutdown).
 */
export class PollingLoop {
  private running = false;
  private current: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.current;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let moreWork = false;
      try {
        moreWork = await this.tick();
      } catch (error) {
        this.onError(error);
      }
      if (!moreWork && this.running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.intervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }
}
