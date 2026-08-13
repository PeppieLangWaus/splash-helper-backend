import { logWarn } from '../utils/logger';

// Resolves real OSRS item ids for `!log <page>`/`!log missing <page>`/`!pets` chat lines by
// calling the actual public APIs those RuneLite commands are backed by — never by trying to
// parse a client-local `<img=N>` chat tag, which for both commands is a per-viewer-session
// sprite-array index with no relation to the real item id (see RuneProfile's own
// CollectionLogCommand.loadPageIcons(), and RuneLite core's ChatCommandsPlugin.loadPets()).
//
// Deliberately server-side, not plugin-side: doing this from the RuneLite plugin would mean
// every installed copy calls a third-party API on every matching chat line it merely *sees*,
// including for players who only want local file logging — unnecessary network activity a
// plugin shouldn't be making, and the kind of thing RuneLite's Plugin Hub review flags. Here, it
// only ever runs for a message that's already being relayed to this backend (i.e. already
// opted into remote logging) and already passed every other check in chatRelay.ts.

export interface ItemRef {
  id: number;
  quantity: number;
}

export type ItemLogCommand =
  | { kind: 'collection-log'; page: string; missingOnly: boolean }
  | { kind: 'pets' };

const RUNEPROFILE_BASE = 'https://api.runeprofile.com';
const RUNELITE_PETS_URL = 'https://api.runelite.net/chat/pets';
const USER_AGENT = 'splash-helper-backend (+https://github.com/PeppieLangWaus/splash-helper-backend)';
// Bounds how long a `!log`/`!pets` line can hold up the chat-relay endpoint's response — every
// other message is entirely unaffected by this.
const FETCH_TIMEOUT_MS = 4_000;

// Sent as `Authorization: Bearer <token>` on RuneProfile calls once set — an authenticated call
// is expected to get a higher (or no) rate limit than the unauthenticated default this otherwise
// runs under. Unset by default; every call is unauthenticated (and self-throttled below, see
// RUNEPROFILE_RATE_LIMIT_*) until a token is issued and configured. NOT yet confirmed against
// RuneProfile's own docs which header/scheme they actually expect — Bearer is the common-case
// guess; adjust here once that's confirmed.
const RUNEPROFILE_API_TOKEN = process.env.RUNEPROFILE_API_TOKEN;

const LOG_COMMAND_PATTERN = /^!log\s+(missing\s+)?(.+)$/i;
const PETS_COMMAND_PATTERN = /^!pets$/i;

// ── Outbound rate limiting ───────────────────────────────────────────────────

/**
 * Self-imposed sliding-window cap on how many requests this backend sends to one destination per
 * window, so a burst of `!log`/`!pets` commands (busy FC, or several relay-runners each
 * independently triggering the same resolution) can't hammer someone else's API — especially
 * relevant while running unauthenticated against RuneProfile's, which has no token-backed
 * allowance of its own yet. Not persisted/shared across instances — fine for this project's
 * single-process deployment (see middleware/rateLimit.ts for the same sliding-window shape,
 * applied there to *inbound* requests instead of outbound ones).
 */
class OutboundRateLimiter {
  private timestamps: number[] = [];
  // Set (and extended) by blockFor() after an upstream 429 — on top of, not instead of, the
  // normal sliding window below.
  private blockedUntil = 0;

  constructor(private readonly windowMs: number, private readonly max: number) {}

  /** True (and records it) if a request may proceed right now; false if either this window's
   *  cap is already spent or a prior 429's backoff (see `blockFor`) is still in effect. Callers
   *  skip the request entirely on false — this never queues/delays, matching every other failure
   *  mode here (a `!log`/`!pets` line just doesn't get items this time, nothing throws). */
  tryAcquire(): boolean {
    const now = Date.now();
    if (now < this.blockedUntil) return false;

    const windowStart = now - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > windowStart);
    if (this.timestamps.length >= this.max) return false;

    this.timestamps.push(now);
    return true;
  }

  blockFor(retryAfterMs: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + retryAfterMs);
  }
}

// Conservative defaults for a service we're calling unauthenticated — deliberately well under
// what's likely to actually trip RuneProfile's/RuneLite's own limits, tunable without a redeploy
// once real-world behavior (or a rate limit RuneProfile documents for the token) says otherwise.
const RUNEPROFILE_RATE_LIMIT_MAX = Number(process.env.RUNEPROFILE_RATE_LIMIT_MAX ?? 30);
const RUNEPROFILE_RATE_LIMIT_WINDOW_MS = Number(process.env.RUNEPROFILE_RATE_LIMIT_WINDOW_MS ?? 60_000);
const RUNELITE_RATE_LIMIT_MAX = Number(process.env.RUNELITE_RATE_LIMIT_MAX ?? 30);
const RUNELITE_RATE_LIMIT_WINDOW_MS = Number(process.env.RUNELITE_RATE_LIMIT_WINDOW_MS ?? 60_000);
// Backoff applied on a 429 with no (parseable) Retry-After header of its own.
const DEFAULT_RETRY_AFTER_MS = 30_000;

const runeProfileLimiter = new OutboundRateLimiter(RUNEPROFILE_RATE_LIMIT_WINDOW_MS, RUNEPROFILE_RATE_LIMIT_MAX);
const runeLiteLimiter = new OutboundRateLimiter(RUNELITE_RATE_LIMIT_WINDOW_MS, RUNELITE_RATE_LIMIT_MAX);

/** Reads a 429's Retry-After header (either delta-seconds or an HTTP-date, both valid per spec)
 *  and falls back to DEFAULT_RETRY_AFTER_MS for anything absent/unparseable. */
function parseRetryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

  return DEFAULT_RETRY_AFTER_MS;
}

/** Detects whether a relayed chat message's raw text is one of the two commands this resolves,
 *  without making any network call yet. Returns null for everything else. */
export function detectItemLogCommand(message: string): ItemLogCommand | null {
  const trimmed = message.trim();

  const logMatch = LOG_COMMAND_PATTERN.exec(trimmed);
  if (logMatch) {
    return { kind: 'collection-log', missingOnly: logMatch[1] !== undefined, page: logMatch[2].trim() };
  }

  if (PETS_COMMAND_PATTERN.test(trimmed)) {
    return { kind: 'pets' };
  }

  return null;
}

/** @param authenticate Attaches RUNEPROFILE_API_TOKEN as a Bearer token when set — only ever
 *  passed true for RuneProfile calls, never RuneLite's (which has no token mechanism here). */
async function fetchJson(url: string, limiter: OutboundRateLimiter, authenticate: boolean): Promise<unknown | null> {
  if (!limiter.tryAcquire()) {
    logWarn(`Item log resolution skipped (self-imposed rate limit reached): ${url}`);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
    if (authenticate && RUNEPROFILE_API_TOKEN) {
      headers.Authorization = `Bearer ${RUNEPROFILE_API_TOKEN}`;
    }

    const res = await fetch(url, { headers, signal: controller.signal });

    if (res.status === 429) {
      limiter.blockFor(parseRetryAfterMs(res.headers.get('Retry-After')));
      logWarn(`Item log resolution rate-limited by upstream, backing off: ${url}`);
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    logWarn(`Item log resolution request to ${url} failed: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

interface CollectionLogPageResponse {
  name?: string;
  items?: Array<{ id: number; quantity: number }>;
}

/** `page` is passed straight through as typed — RuneProfile's own API is assumed to handle alias
 *  resolution (`!log cox`, etc.) the same way the command itself would. Returns null on any
 *  failure (unlinked account, unknown page, network error, timeout) — never throws. */
async function resolveCollectionLogPage(
  username: string,
  page: string,
  missingOnly: boolean,
): Promise<ItemRef[] | null> {
  const url = `${RUNEPROFILE_BASE}/profiles/${encodeURIComponent(username)}/collection-log/${encodeURIComponent(page)}`;
  const data = await fetchJson(url, runeProfileLimiter, true) as CollectionLogPageResponse | null;
  if (!data || !Array.isArray(data.items)) return null;

  const kept: ItemRef[] = [];
  for (const item of data.items) {
    if (typeof item.id !== 'number' || typeof item.quantity !== 'number') continue;
    const obtained = item.quantity > 0;
    // Normal view keeps obtained items; "missing" view keeps the ones that aren't.
    if (obtained !== missingOnly) kept.push({ id: item.id, quantity: item.quantity });
  }
  return kept;
}

/** Pets are never stackable, so every returned quantity is 1. Returns null on any failure (the
 *  player has never run `!pets` themselves, network error, timeout) — never throws. */
async function resolvePets(username: string): Promise<ItemRef[] | null> {
  const url = `${RUNELITE_PETS_URL}?name=${encodeURIComponent(username)}`;
  const data = await fetchJson(url, runeLiteLimiter, false);
  if (!Array.isArray(data)) return null;
  return data.filter((id): id is number => typeof id === 'number').map((id) => ({ id, quantity: 1 }));
}

/** Resolves an already-detected command for the given sender. Returns null (never throws) if the
 *  underlying API call fails for any reason — callers should just omit item data in that case,
 *  the same as for a message that never matched a command at all. */
export async function resolveItemLogCommand(username: string, command: ItemLogCommand): Promise<ItemRef[] | null> {
  return command.kind === 'collection-log'
    ? resolveCollectionLogPage(username, command.page, command.missingOnly)
    : resolvePets(username);
}
