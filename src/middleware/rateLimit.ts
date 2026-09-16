import { Request, Response, NextFunction } from 'express';
import { getClientIp } from '../utils/clientIp';
import { createSlidingWindowLimiter } from '../utils/slidingWindowLimiter';

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
  const limiter = createSlidingWindowLimiter(windowMs, max);

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = (keyFn ? keyFn(req) : getClientIp(req)) ?? 'unknown';
    if (!limiter.allow(key)) {
      res.status(429).json({ error: 'Too many attempts. Please try again later.' });
      return;
    }
    next();
  };
}
