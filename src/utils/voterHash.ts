import { createHash } from 'crypto';

/** Anonymous voter identity for public like/dislike endpoints (see routes/splashers.ts). We
 *  dedupe repeat votes by a salted hash of the requester's IP rather than requiring an account
 *  — good enough to stop trivial double-voting/clicking without ever persisting a raw IP. Not
 *  meant to resist a determined abuser (a new IP or a VPN sidesteps it entirely), same tradeoff
 *  as the per-IP rate limiter in middleware/rateLimit.ts. */
export function hashVoterIp(ip: string): string {
  const salt = process.env.VOTER_HASH_SALT ?? 'splash-helper-voter';
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}
