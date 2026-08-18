import { Request } from 'express';
import { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';

/**
 * Pulls a validated address out of the `CF-Connecting-IP` header — set by Cloudflare's edge to
 * the true visitor IP, regardless of how many internal hops (nginx, etc.) sit between Cloudflare
 * and this app. Returns undefined if the header is missing or malformed, e.g. in local dev
 * without Cloudflare in front.
 *
 * Only trustworthy because the origin is expected to be locked down to accept traffic only from
 * Cloudflare's IP ranges — otherwise a client could hit the origin directly and spoof this
 * header. If that firewalling ever lapses, this header can no longer be trusted.
 */
export function getCfConnectingIp(headers: IncomingHttpHeaders): string | undefined {
  const header = headers['cf-connecting-ip'];
  const cfIp = Array.isArray(header) ? header[0] : header;
  return cfIp && isIP(cfIp.trim()) ? cfIp.trim() : undefined;
}

/**
 * Resolves the real client IP for an Express request.
 *
 * Prefers `getCfConnectingIp()` over `req.ip`. `req.ip` depends on `trust proxy` (see app.ts)
 * correctly counting *every* hop between the client and this app; that count has to be kept in
 * sync by hand any time the proxy topology changes (e.g. adding/removing Cloudflare), and
 * silently returns the wrong address if it's ever off by one — `CF-Connecting-IP` doesn't have
 * that problem.
 *
 * Falls back to `req.ip` (still dependent on an accurate `trust proxy` hop count) when the
 * header is absent.
 */
export function getClientIp(req: Request): string {
  return getCfConnectingIp(req.headers) ?? req.ip ?? 'unknown';
}
