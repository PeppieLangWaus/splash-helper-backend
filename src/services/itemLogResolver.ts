import { logWarn } from '../utils/logger';

// Resolves real OSRS item ids for `!log <page>`/`!log missing <page>`/`!pets` chat lines by
// calling the actual public API those commands are conceptually backed by — RuneProfile's own
// collection-log endpoint for both (see below for why `!pets` uses it too) — never by trying to
// parse a client-local `<img=N>` chat tag, which is a per-viewer-session sprite-array index with
// no relation to the real item id (see RuneProfile's own CollectionLogCommand.loadPageIcons(),
// and RuneLite core's ChatCommandsPlugin.loadPets()).
//
// `!pets` resolves against RuneProfile's collection-log page named "pets" (OSRS's own collection
// log has a dedicated Pets tab, and RuneProfile syncs it like any other page) rather than
// RuneLite's own api.runelite.net/chat/pets, which turned out to be dead — 404s even for a known
// active player's real username, not just "no data for this account".
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

export interface ItemLogResolution {
  /** Clean line summarizing what this resolved to, e.g. "Cyclopes (8/8):" or "Pets (3):" — built
   *  from the resolved data itself, meant to replace the plugin's own raw/rewritten message text
   *  wherever this resolution succeeds. */
  summary: string;
  items: ItemRef[];
  /** Whether a per-item quantity ("xN") is meaningful to show at all. True for collection log
   *  pages (an item's `quantity` there is the real owned count, 0 meaning not yet obtained).
   *  False for pets — RuneProfile's data model reports a numeric quantity for these too, but
   *  owning a pet isn't a "count" the way owning 5 arrows is, so it's never shown. */
  showQuantities: boolean;
}

export type ItemLogCommand =
  | { kind: 'collection-log'; page: string; missingOnly: boolean }
  | { kind: 'pets' };

const RUNEPROFILE_BASE = 'https://api.runeprofile.com';
const USER_AGENT = 'splash-helper-backend (+https://github.com/PeppieLangWaus/splash-helper-backend)';
// Bounds how long a `!log`/`!pets` line can hold up the chat-relay endpoint's response — every
// other message is entirely unaffected by this.
const FETCH_TIMEOUT_MS = 4_000;

// Sent as `Authorization: Bearer <token>` once set — an authenticated call is expected to get a
// higher (or no) rate limit than the unauthenticated default this otherwise runs under. Unset by
// default; every call is unauthenticated (and self-throttled below, see RUNEPROFILE_RATE_LIMIT_*)
// until a token is issued and configured. NOT yet confirmed against RuneProfile's own docs which
// header/scheme they actually expect — Bearer is the common-case guess; adjust here once that's
// confirmed.
const RUNEPROFILE_API_TOKEN = process.env.RUNEPROFILE_API_TOKEN;

const LOG_COMMAND_PATTERN = /^!log\s+(missing\s+)?(.+)$/i;
const PETS_COMMAND_PATTERN = /^!pets$/i;
// The collection log page RuneProfile stores pet ownership under - confirmed live: querying this
// page name returns `{"name": "All Pets", "items": [...]}` for a linked account.
const PETS_PAGE = 'pets';

// ── Outbound rate limiting ───────────────────────────────────────────────────

/**
 * Self-imposed sliding-window cap on how many requests this backend sends to RuneProfile's API
 * per window, so a burst of `!log`/`!pets` commands (busy FC, or several relay-runners each
 * independently triggering the same resolution) can't hammer it — especially relevant while
 * running unauthenticated, with no token-backed allowance of our own yet. Not persisted/shared
 * across instances — fine for this project's single-process deployment (see middleware/
 * rateLimit.ts for the same sliding-window shape, applied there to *inbound* requests instead).
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

// Conservative default for a service we're calling unauthenticated — deliberately well under
// what's likely to actually trip RuneProfile's own limits, tunable without a redeploy once
// real-world behavior (or a rate limit RuneProfile documents for the token) says otherwise.
const RUNEPROFILE_RATE_LIMIT_MAX = Number(process.env.RUNEPROFILE_RATE_LIMIT_MAX ?? 30);
const RUNEPROFILE_RATE_LIMIT_WINDOW_MS = Number(process.env.RUNEPROFILE_RATE_LIMIT_WINDOW_MS ?? 60_000);
// Backoff applied on a 429 with no (parseable) Retry-After header of its own.
const DEFAULT_RETRY_AFTER_MS = 30_000;

const runeProfileLimiter = new OutboundRateLimiter(RUNEPROFILE_RATE_LIMIT_WINDOW_MS, RUNEPROFILE_RATE_LIMIT_MAX);

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

/** Strips a leading `<img=N>` mod/ironman-status tag (the client embeds it right in the sender
 *  name — chatRelay.ts's `sender` deliberately keeps it intact for the frontend's own use) and
 *  normalizes U+00A0 (non-breaking space, used between first/last name in a two-word RSN) to a
 *  plain space — RuneProfile's own account lookup needs the real, plain username, not the
 *  display-facing value chatRelay.ts otherwise passes around untouched. */
function sanitizeUsernameForLookup(name: string): string {
  const withoutTag = name.includes('<img') ? name.slice(name.lastIndexOf('>') + 1) : name;
  return withoutTag.replace(/\u00A0/g, ' ').trim();
}

async function fetchJson(url: string): Promise<unknown | null> {
  if (!runeProfileLimiter.tryAcquire()) {
    logWarn(`Item log resolution skipped (self-imposed rate limit reached): ${url}`);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
    if (RUNEPROFILE_API_TOKEN) {
      headers.Authorization = `Bearer ${RUNEPROFILE_API_TOKEN}`;
    }

    const res = await fetch(url, { headers, signal: controller.signal });

    if (res.status === 429) {
      runeProfileLimiter.blockFor(parseRetryAfterMs(res.headers.get('Retry-After')));
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

async function fetchCollectionLogPage(username: string, page: string): Promise<CollectionLogPageResponse | null> {
  const url = `${RUNEPROFILE_BASE}/profiles/${encodeURIComponent(username)}/collection-log/${encodeURIComponent(page)}`;
  return await fetchJson(url) as CollectionLogPageResponse | null;
}

/** `page` is passed straight through as typed — RuneProfile's own API is assumed to handle alias
 *  resolution (`!log cox`, etc.) the same way the command itself would. Returns null on any
 *  failure (unlinked account, unknown page, network error, timeout, rate-limited) — never throws.
 *
 *  Normal view includes *every* item on the page (obtained and not), so a viewer sees the full
 *  set with each one's real quantity — 0 for anything not yet obtained. Missing view keeps only
 *  the not-yet-obtained ones, each necessarily quantity 0. */
async function resolveCollectionLogPage(
  username: string,
  page: string,
  missingOnly: boolean,
): Promise<ItemLogResolution | null> {
  const data = await fetchCollectionLogPage(username, page);
  if (!data || !Array.isArray(data.items)) return null;

  let obtainedCount = 0;
  const kept: ItemRef[] = [];
  for (const item of data.items) {
    if (typeof item.id !== 'number' || typeof item.quantity !== 'number') continue;
    const obtained = item.quantity > 0;
    if (obtained) obtainedCount++;
    if (!missingOnly || !obtained) kept.push({ id: item.id, quantity: item.quantity });
  }

  const pageName = data.name ?? page;
  const totalCount = data.items.length;
  const summary = missingOnly
    ? `${pageName} - missing (${totalCount - obtainedCount}/${totalCount}):`
    : `${pageName} (${obtainedCount}/${totalCount}):`;

  return { summary, items: kept, showQuantities: true };
}

/** Resolves via RuneProfile's own "pets" collection-log page rather than RuneLite's (dead) pets
 *  endpoint — see the module doc comment. Only obtained pets are included, matching how the
 *  native `!pets` command itself only lists owned ones rather than every pet with an indicator.
 *  Returns null on any failure — never throws. */
async function resolvePets(username: string): Promise<ItemLogResolution | null> {
  const data = await fetchCollectionLogPage(username, PETS_PAGE);
  if (!data || !Array.isArray(data.items)) return null;

  const owned: ItemRef[] = [];
  for (const item of data.items) {
    if (typeof item.id !== 'number' || typeof item.quantity !== 'number') continue;
    if (item.quantity > 0) owned.push({ id: item.id, quantity: item.quantity });
  }

  return { summary: `Pets (${owned.length}):`, items: owned, showQuantities: false };
}

/** Resolves an already-detected command for the given (display-facing, possibly tag/NBSP-laden)
 *  sender name. Returns null (never throws) if the underlying API call fails for any reason —
 *  callers should just leave the original message text alone in that case, the same as for a
 *  message that never matched a command at all. */
export async function resolveItemLogCommand(sender: string, command: ItemLogCommand): Promise<ItemLogResolution | null> {
  const username = sanitizeUsernameForLookup(sender);
  return command.kind === 'collection-log'
    ? resolveCollectionLogPage(username, command.page, command.missingOnly)
    : resolvePets(username);
}
