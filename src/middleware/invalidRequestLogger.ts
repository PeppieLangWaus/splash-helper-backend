import { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { getClientIp } from '../utils/clientIp';

/** Request augmented by the `verify` hook on `express.json()` in app.ts, which stashes the raw
 *  body text before parsing -- needed because a JSON parse failure means `req.body` was never
 *  populated, so it's the only way to see what a scanner actually sent. */
type RequestWithRawBody = Request & { rawBody?: string };

type InvalidRequestReason = 'not-found' | 'invalid-json' | 'payload-too-large';

const SENSITIVE_HEADERS = new Set([
  'authorization', 'cookie', 'x-admin-secret', 'x-community-token', 'x-api-key', 'proxy-authorization',
]);
const MAX_HEADER_VALUE_LENGTH = 500;
const MAX_BODY_LENGTH = 2000;
const MAX_PATH_LENGTH = 1000;

// In-memory, per-IP budget so one aggressive scanner can't spam thousands of log lines a second
// (this all flows to Axiom via Coolify's log drain, so unbounded volume is both noisy and a real
// ingestion cost, not just a local nuisance). Not shared across instances -- fine for this
// project's single-process deployment (same tradeoff as middleware/rateLimit.ts). Exceeding the
// budget just stops logging for that IP for the rest of the window; the request itself is still
// rejected normally.
const LOG_WINDOW_MS = 60_000;
const MAX_LOGS_PER_IP_PER_WINDOW = 30;
const recentLogTimestamps = new Map<string, number[]>();

function withinLogBudget(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - LOG_WINDOW_MS;
  const timestamps = (recentLogTimestamps.get(ip) ?? []).filter((t) => t > windowStart);
  if (timestamps.length >= MAX_LOGS_PER_IP_PER_WINDOW) {
    recentLogTimestamps.set(ip, timestamps);
    return false;
  }
  timestamps.push(now);
  recentLogTimestamps.set(ip, timestamps);
  return true;
}

function sanitizeHeaders(headers: Request['headers']): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const raw = Array.isArray(value) ? value.join(', ') : value;
    sanitized[key] = SENSITIVE_HEADERS.has(key.toLowerCase())
      ? '[redacted]'
      : raw.slice(0, MAX_HEADER_VALUE_LENGTH);
  }
  return sanitized;
}

function safeBody(body: unknown): unknown {
  if (body === undefined || body === null) return undefined;
  try {
    const str = typeof body === 'string' ? body : JSON.stringify(body);
    if (!str || str === '{}') return undefined;
    return str.length > MAX_BODY_LENGTH ? `${str.slice(0, MAX_BODY_LENGTH)}…[truncated]` : str;
  } catch {
    return undefined;
  }
}

/**
 * Writes a single structured JSON line to stdout for a request the API rejected outright. Almost
 * entirely exploit-scanner noise (probes for /.env, /wp-login.php, malformed/oversized bodies,
 * ...) rather than real user traffic. Deliberately just a console line rather than a DB write or
 * admin API -- Coolify's log drain ships stdout to Axiom, which is where this is meant to be
 * reviewed.
 */
function record(req: Request, statusCode: number, reason: InvalidRequestReason, rawBody?: unknown): void {
  const ip = getClientIp(req);
  if (!withinLogBudget(ip)) return;

  console.warn(JSON.stringify({
    event: 'invalid_request',
    method: req.method,
    path: (req.originalUrl || req.url || '').slice(0, MAX_PATH_LENGTH),
    ip,
    statusCode,
    reason,
    headers: sanitizeHeaders(req.headers),
    body: safeBody(rawBody ?? req.body),
  }));
}

/**
 * Catches any request that fell through every mounted router unmatched. Almost always an exploit
 * scanner probing for known-vulnerable paths (/.env, /wp-login.php, phpMyAdmin, ...) since real
 * clients only ever hit documented routes. Must be mounted with `app.use` after every route.
 */
export function notFoundLogger(req: Request, res: Response, _next: NextFunction): void {
  record(req, 404, 'not-found');
  res.status(404).json({ error: 'Not found' });
}

/**
 * Catches body-parser failures from `express.json()` -- malformed JSON and oversized payloads.
 * Must be registered as an error-handling middleware (4 params); Express routes thrown/`next(err)`
 * errors to the first one it finds regardless of where it sits relative to the failing
 * middleware, so this only needs to be mounted somewhere after `express.json()` is set up.
 */
export const invalidBodyLogger: ErrorRequestHandler = (err, req, res, next) => {
  const requestErr = err as { type?: string } | undefined;
  if (requestErr?.type === 'entity.parse.failed') {
    record(req, 400, 'invalid-json', (req as RequestWithRawBody).rawBody);
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }
  if (requestErr?.type === 'entity.too.large') {
    record(req, 413, 'payload-too-large');
    res.status(413).json({ error: 'Payload too large' });
    return;
  }
  next(err);
};
