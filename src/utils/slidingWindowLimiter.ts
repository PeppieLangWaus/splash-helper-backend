/** Keys with at least this many tracked entries trigger a sweep of fully-expired keys, so a
 *  long-running limiter hit by many one-off keys (e.g. scanner IPs) can't grow unbounded. */
const PRUNE_THRESHOLD = 1000;

export interface SlidingWindowLimiter {
  /** Records a hit for `key` and returns true if it's still within the allowed budget. */
  allow(key: string): boolean;
}

/** In-memory sliding window: at most `max` hits per `windowMs` per key. Not shared across
 *  server instances — fine for this project's single-process deployment. */
export function createSlidingWindowLimiter(windowMs: number, max: number): SlidingWindowLimiter {
  const hits = new Map<string, number[]>();

  function pruneExpired(now: number): void {
    if (hits.size < PRUNE_THRESHOLD) return;
    const windowStart = now - windowMs;
    for (const [key, timestamps] of hits) {
      if (!timestamps.some((t) => t > windowStart)) {
        hits.delete(key);
      }
    }
  }

  return {
    allow(key: string): boolean {
      const now = Date.now();
      pruneExpired(now);

      const windowStart = now - windowMs;
      const timestamps = (hits.get(key) ?? []).filter((t) => t > windowStart);
      if (timestamps.length >= max) {
        hits.set(key, timestamps);
        return false;
      }

      timestamps.push(now);
      hits.set(key, timestamps);
      return true;
    },
  };
}
