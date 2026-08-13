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

const LOG_COMMAND_PATTERN = /^!log\s+(missing\s+)?(.+)$/i;
const PETS_COMMAND_PATTERN = /^!pets$/i;

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

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
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
  const data = await fetchJson(url) as CollectionLogPageResponse | null;
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
  const data = await fetchJson(url);
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
