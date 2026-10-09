/** Retries `assertion` until it passes or `timeoutMs` elapses (for asynchronous workers and queues). */
export async function eventually<T>(assertion: () => Promise<T>, timeoutMs = 10_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await assertion();
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await Bun.sleep(intervalMs);
    }
  }
}
