/**
 * Per-key sliding-window rate limiter that WAITS (used to respect the
 * per-tribunal request limit of the DataJud public API, RNF-03). In-memory and
 * per process: several workers each keep their own window, so the effective
 * limit is "max per minute per worker". Clock and sleep are injectable (tests).
 */

export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export class SlidingWindowLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: Clock = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {}

  /** Milliseconds to wait before one more call for `key` fits in the window (0 = now). */
  waitTime(key: string, maxPerWindow: number): number {
    const max = Math.max(1, Math.floor(maxPerWindow));
    const t = this.now();
    const recent = (this.windows.get(key) ?? []).filter((at) => t - at < this.windowMs);
    this.windows.set(key, recent);
    if (recent.length < max) return 0;
    return recent[recent.length - max] + this.windowMs - t;
  }

  /** Waits until a call for `key` is allowed and records it. Returns how long it waited. */
  async acquire(key: string, maxPerWindow: number): Promise<number> {
    let waited = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const wait = this.waitTime(key, maxPerWindow);
      if (wait <= 0) break;
      await this.sleep(wait);
      waited += wait;
    }
    const list = this.windows.get(key) ?? [];
    list.push(this.now());
    this.windows.set(key, list);
    return waited;
  }

  reset(): void {
    this.windows.clear();
  }
}
