import { randomBytes, createHash } from 'crypto';

const TOKEN_BYTES = 32;

/** Hashes a raw token with SHA-256 — the only form ever persisted to the database, so a DB leak
 *  alone can never be replayed into a password reset or email verification (the raw value only
 *  ever existed in the one-time link sent to the user's inbox). */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Generates a fresh reset/verification token: the raw value (goes in the emailed link, never
 *  stored) and its hash (the only thing written to the database). */
export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(TOKEN_BYTES).toString('hex');
  return { raw, hash: hashToken(raw) };
}
