export type Settled<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

/**
 * Run `fn` over `items` with at most `limit` in-flight promises at a time.
 * Results preserve input order; individual failures are collected per item so
 * the caller can decide how to surface them. Never rejects as a whole.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Settled<R>[]> {
  if (items.length === 0) return [];
  const results = new Array<Settled<R>>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) break;
      try {
        results[idx] = { status: "fulfilled", value: await fn(items[idx], idx) };
      } catch (reason) {
        results[idx] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** A simple counting semaphore for mixing parallel and serialized work. */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.release.bind(this);
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    return this.release.bind(this);
  }

  /** Run `fn` holding one permit; concurrent callers are capped at `max`. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}
