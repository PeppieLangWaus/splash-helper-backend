import { Request, Response, NextFunction } from 'express';
import { getClientIp } from '../utils/clientIp';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Defaults to per-IP (`getClientIp(req)`). Override to key by something else — e.g. the
   *  authenticated username, or a field pulled from the request body — for a per-account/
   *  per-target limiter instead of a per-client one. */
  keyFn?: (req: Request) => string;
}

/**
 * Minimal in-memory, per-IP sliding-window limiter for a single route. Not shared across
 * server instances — fine for the low-traffic, single-process deployment this project runs.
 */
export function rateLimit({ windowMs, max, keyFn }: RateLimitOptions) {
  const hits = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = (keyFn ? keyFn(req) : getClientIp(req)) ?? 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    const timestamps = (hits.get(key) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= max) {
      res.status(429).json({ error: 'Too many attempts. Please try again later.' });
      return;
    }

    timestamps.push(now);
    hits.set(key, timestamps);
    next();
  };
}
