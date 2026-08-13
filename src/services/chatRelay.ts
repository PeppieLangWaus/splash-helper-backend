import { Types } from 'mongoose';
import { Community, ICommunity } from '../models/Community';
import { ChatChannelName, ChatChannelType, normalizeChatChannelName } from '../models/ChatChannelName';
import { forwardChatWebhookPayload } from './discordWebhook';
import { RankInfo, getFriendsChatRankInfo, getClanRankIconUrl } from './rankIcons';
import { detectItemLogCommand, resolveItemLogCommand } from './itemLogResolver';
import { broadcastChatMessage } from '../websocket/chatBroadcast';
import { log, logWarn } from '../utils/logger';

// Discord's own message length cap — also used as a sanity ceiling for the in-game message text.
const MAX_CONTENT_LENGTH = 2000;
// Sanity ceiling for the chatName/sender fields.
const MAX_NAME_LENGTH = 100;

/** The `message.type` values the plugin sends, mapped to our internal fc/cc distinction. Note the
 *  inconsistent underscore — that's genuinely how the plugin spells them. */
const MESSAGE_TYPE_TO_CHANNEL_TYPE: Record<string, ChatChannelType> = {
  FRIENDSCHAT: 'fc',
  CLAN_CHAT: 'cc',
};

/**
 * One chat line exactly as the plugin posts it — see routes/chatRelay.ts. `friendsChat` is
 * present for a FRIENDSCHAT message, `clanChat` for a CLAN_CHAT one (never both). `user` describes
 * whoever sent the message (not the local player running the plugin) — its `friendsChatRank` is
 * only meaningful for a FRIENDSCHAT message, `clanRank` only for a CLAN_CHAT one, but the plugin
 * sends both regardless of which chat this line came from.
 */
export interface RawChatRelayMessage {
  message: {
    id: number;
    /** Unix epoch *seconds* (not ms). */
    timestamp: number;
    type: string;
    text: string;
    /** True for a follow-up resend of a message already sent once — same `id`/`timestamp`/`type`
     *  as the original, but `text` updated to a since-resolved chat command's output. Arrives
     *  within ~8s of the original, or (for most messages) not at all. Absent/false for the
     *  original send itself. */
    edited?: boolean;
  };
  user: {
    name: string;
    type?: number;
    /** Numeric ClanRank value plus the clan's own configured title for it (already resolved
     *  client-side via ClanSettings#titleForRank — this relay has no other way to get it). */
    clanRank?: { rank: number; title: string };
    /** FriendsChatRank enum *name* (e.g. "OWNER"), not its numeric value. */
    friendsChatRank?: string;
  };
  friendsChat?: { name: string; owner?: string };
  clanChat?: { name: string };
}

export interface ParsedChatMessage {
  channelType: ChatChannelType;
  chatName: string;
  sender: string;
  message: string;
  rankInfo: RankInfo | null;
  /** The plugin's own per-session identifiers for this line — meaningful only for correlating an
   *  `edited` resend with the original it updates (see chatBroadcast.ts), never for display.
   *  `sourceId` alone is not globally unique (it's a small per-session counter from the game
   *  client), so always look up by all three together. */
  sourceId: number;
  sourceTimestamp: number;
  sourceType: string;
  /** True when this is a follow-up resend of a message already sent once, with `message` updated
   *  to a since-resolved chat command's output. */
  edited: boolean;
}

function parseClanRankInfo(raw: unknown): RankInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.rank !== 'number' || !Number.isFinite(c.rank)) return null;
  if (typeof c.title !== 'string' || !c.title.trim()) return null;
  return { rank: c.rank, name: c.title.trim(), iconUrl: getClanRankIconUrl(c.rank) };
}

/** Returns null for anything that doesn't look like a genuine plugin message — callers should
 *  drop those silently rather than relay or broadcast them. */
export function parseChatRelayMessage(raw: unknown): ParsedChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  if (!r.message || typeof r.message !== 'object') return null;
  const m = r.message as Record<string, unknown>;

  const channelType = typeof m.type === 'string' ? MESSAGE_TYPE_TO_CHANNEL_TYPE[m.type] : undefined;
  if (!channelType) return null;

  if (typeof m.text !== 'string') return null;
  const message = m.text.trim();
  if (!message || message.length > MAX_CONTENT_LENGTH) return null;

  if (typeof m.id !== 'number' || !Number.isFinite(m.id)) return null;
  if (typeof m.timestamp !== 'number' || !Number.isFinite(m.timestamp)) return null;
  // Anything other than the literal `true` is treated as "not an edited resend" — absent, false,
  // or a malformed value all mean the same thing here.
  const edited = m.edited === true;

  if (!r.user || typeof r.user !== 'object') return null;
  const u = r.user as Record<string, unknown>;
  if (typeof u.name !== 'string' || !u.name.trim() || u.name.length > MAX_NAME_LENGTH) return null;
  const sender = u.name.trim();

  // The chat name lives in whichever of friendsChat/clanChat matches this message's own declared
  // type — not just "whichever is present", so a message can't smuggle itself in under the wrong
  // container.
  const container = channelType === 'fc' ? r.friendsChat : r.clanChat;
  if (!container || typeof container !== 'object') return null;
  const c = container as Record<string, unknown>;
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > MAX_NAME_LENGTH) return null;
  const chatName = c.name.trim();

  const rankInfo = channelType === 'fc'
    ? getFriendsChatRankInfo(typeof u.friendsChatRank === 'string' ? u.friendsChatRank : undefined)
    : parseClanRankInfo(u.clanRank);

  return {
    channelType,
    chatName,
    sender,
    message,
    rankInfo,
    sourceId: m.id,
    sourceTimestamp: m.timestamp,
    sourceType: m.type as string,
    edited,
  };
}

// ── Chat-name → community classification ────────────────────────────────────

interface ChannelBinding {
  communityId: string;
  channelType: ChatChannelType;
}

const CACHE_TTL_MS = process.env.CHAT_RELAY_CACHE_TTL_MS !== undefined
  ? Number(process.env.CHAT_RELAY_CACHE_TTL_MS)
  : 15_000;

// Keyed by `${channelType}|${normalizedName}` rather than name alone — FC and CC are separate
// in-game namespaces, so the same name can legitimately be registered as both at once (even to
// different communities); collapsing them onto one key would make one silently shadow the other.
let bindingCache = new Map<string, ChannelBinding>();
let bindingCacheAt = 0;

function bindingCacheKey(normalizedName: string, channelType: ChatChannelType): string {
  return `${channelType}|${normalizedName}`;
}

async function refreshBindingCacheIfStale(): Promise<void> {
  const now = Date.now();
  if (now - bindingCacheAt < CACHE_TTL_MS) return;
  bindingCacheAt = now;

  try {
    const entries = await ChatChannelName.find({}, { normalizedName: 1, communityId: 1, channelType: 1 }).lean();
    bindingCache = new Map(
      entries.map((e) => [
        bindingCacheKey(e.normalizedName, e.channelType),
        { communityId: e.communityId.toString(), channelType: e.channelType },
      ]),
    );
  } catch (err) {
    logWarn(`Failed to refresh chat-relay binding cache: ${(err as Error).message}`);
  }
}

/** Resolves a parsed message's chat name + channel type to the community that registered it, or
 *  null if no community currently claims that (name, type) pair. */
export async function resolveChatBinding(
  chatName: string,
  channelType: ChatChannelType,
): Promise<ChannelBinding | null> {
  await refreshBindingCacheIfStale();
  return bindingCache.get(bindingCacheKey(normalizeChatChannelName(chatName), channelType)) ?? null;
}

// ── Source tracking (in-memory, for the admin block-list) ───────────────────

export interface ChatSourceEntry {
  ip: string;
  sender?: string;
  channelType: ChatChannelType;
  at: number;
}

const MAX_TRACKED_SOURCES_PER_COMMUNITY = 50;
const recentSources = new Map<string, ChatSourceEntry[]>();

function recordChatSource(communityId: string, entry: ChatSourceEntry): void {
  const list = recentSources.get(communityId) ?? [];
  list.push(entry);
  if (list.length > MAX_TRACKED_SOURCES_PER_COMMUNITY) list.shift();
  recentSources.set(communityId, list);
}

/** Recent sources seen for a community's chat relay, newest last — for the owner's block-list UI. */
export function getRecentChatSources(communityId: string): ChatSourceEntry[] {
  return recentSources.get(communityId) ?? [];
}

function isBlockedSource(community: ICommunity, ip: string, sender: string | undefined): boolean {
  const normalizedSender = sender?.trim().toLowerCase();
  return community.blockedChatSources.some((blocked) => {
    if (blocked.ip && blocked.ip === ip) return true;
    if (blocked.playerName && normalizedSender && blocked.playerName.trim().toLowerCase() === normalizedSender) {
      return true;
    }
    return false;
  });
}

// ── Deduplication ─────────────────────────────────────────────────────────────

/**
 * Every player running the plugin in the same Friends/Clan Chat captures and posts the *same*
 * real chat line independently. There's no id shared across their clients to key on — each
 * message's `id` is only meaningful to the client that generated it — so duplicates have to be
 * recognized by content instead: the same channel + chat name + sender + message arriving again
 * within a short window is almost certainly a second (or third, or tenth) observer relaying one
 * message, not the same player legitimately repeating themselves seconds apart.
 */
const DEDUP_WINDOW_MS = process.env.CHAT_RELAY_DEDUP_WINDOW_MS !== undefined
  ? Number(process.env.CHAT_RELAY_DEDUP_WINDOW_MS)
  : 10_000;

const recentlySeen = new Map<string, number>(); // dedup key -> expiry (epoch ms)

function dedupKey(msg: ParsedChatMessage): string {
  return `${msg.channelType}|${normalizeChatChannelName(msg.chatName)}|${msg.sender.toLowerCase()}|${msg.message}`;
}

/** True (and records it) if an equivalent message was already seen within the dedup window;
 *  false (and records this one) otherwise. Expired entries are swept opportunistically here
 *  rather than on a timer — traffic through this endpoint is far too low to need anything more. */
function isDuplicateMessage(msg: ParsedChatMessage, now: number): boolean {
  for (const [key, expiresAt] of recentlySeen) {
    if (expiresAt <= now) recentlySeen.delete(key);
  }

  const key = dedupKey(msg);
  if (recentlySeen.has(key)) return true;
  recentlySeen.set(key, now + DEDUP_WINDOW_MS);
  return false;
}

/** Test-only escape hatch: clears in-memory dedup state so one test's messages can't be seen as
 *  duplicates of another's. */
export function resetChatRelayDedupState(): void {
  recentlySeen.clear();
}

// ── Entry point ───────────────────────────────────────────────────────────────

export type ChatRelayResult =
  | { status: 'forwarded'; communityId: string; channelType: ChatChannelType }
  | { status: 'dropped'; reason: 'invalid-format' | 'unrecognized-source' | 'blocked' | 'duplicate' };

/**
 * Handles one message POSTed to the global chat-relay endpoint (chat.splasher.help /
 * chat.ardy.host — routes/chatRelay.ts): parses + classifies it, drops anything that doesn't
 * check out (including duplicates from other clients relaying the same line), records the source
 * for the owning community's block-list, and forwards allowed messages on to that community's
 * real Discord webhook plus its live frontend viewers.
 */
export async function handleChatRelayPayload(rawMessage: unknown, sourceIp: string): Promise<ChatRelayResult> {
  const parsed = parseChatRelayMessage(rawMessage);
  if (!parsed) return { status: 'dropped', reason: 'invalid-format' };

  if (isDuplicateMessage(parsed, Date.now())) {
    return { status: 'dropped', reason: 'duplicate' };
  }

  // Looked up by (name, type) together — see ChatChannelName's doc comment for why that pair,
  // not the name alone, is the trust mechanism this relay's classification relies on. A name
  // registered as one type but claimed as the other (misconfigured or spoofed) simply won't
  // resolve, and is dropped the same as a name nobody has registered at all.
  const binding = await resolveChatBinding(parsed.chatName, parsed.channelType);
  if (!binding) {
    return { status: 'dropped', reason: 'unrecognized-source' };
  }

  const community = await Community.findById(binding.communityId);
  if (!community) return { status: 'dropped', reason: 'unrecognized-source' };

  if (isBlockedSource(community, sourceIp, parsed.sender)) {
    return { status: 'dropped', reason: 'blocked' };
  }

  recordChatSource(binding.communityId, {
    ip: sourceIp,
    sender: parsed.sender,
    channelType: binding.channelType,
    at: Date.now(),
  });

  const webhookUrl = binding.channelType === 'fc'
    ? community.discordFriendsChatWebhookUrl
    : community.discordClanChatWebhookUrl;
  if (webhookUrl) {
    // Reconstructed to match the format the old Discord-Chat-Logger-style relay used, so an
    // owner's existing Discord channel keeps seeing the same familiar `**[Name]** **Sender** :
    // message` lines regardless of which wire format the plugin posts in.
    forwardChatWebhookPayload(webhookUrl, {
      content: `**[${parsed.chatName}]** **${parsed.sender}** : ${parsed.message}`,
    });
  }

  // `!log <page>`/`!log missing <page>`/`!pets` get their real item data resolved here, from the
  // actual public API each command is backed by (services/itemLogResolver.ts) — not from any
  // `<img=N>` tag the message text might contain, which is a client-local, per-viewer-session
  // sprite index with no relation to the real item id. This does add a bounded network round trip
  // before responding to the relay POST, but only for a message that matches one of these two
  // commands; every other chat line is entirely unaffected.
  const itemLogCommand = detectItemLogCommand(parsed.message);
  const items = itemLogCommand
    ? (await resolveItemLogCommand(parsed.sender, itemLogCommand)) ?? undefined
    : undefined;

  broadcastChatMessage(binding.communityId, binding.channelType, parsed.sender, parsed.message, parsed.rankInfo ?? undefined, {
    id: parsed.sourceId,
    timestamp: parsed.sourceTimestamp,
    type: parsed.sourceType,
    edited: parsed.edited,
  }, items);

  log(`Chat relay: ${binding.channelType} message for community ${binding.communityId} from ${parsed.sender}`);
  return { status: 'forwarded', communityId: binding.communityId, channelType: binding.channelType };
}

/** Validates a candidate FC/CC name isn't already registered — as that *same* channel type — to a
 *  *different* community, for the PUT /communities/:id/chat-config route. Registering the same
 *  name to the same community again (e.g. re-saving unchanged settings) is allowed, and so is an
 *  FC and a CC sharing a name (they're separate in-game namespaces — see ChatChannelName). */
export async function isChatChannelNameTaken(
  normalizedName: string,
  channelType: ChatChannelType,
  byOtherThanCommunityId: Types.ObjectId,
): Promise<boolean> {
  const existing = await ChatChannelName.findOne({ normalizedName, channelType }).lean();
  return !!existing && !existing.communityId.equals(byOtherThanCommunityId);
}

// ── PUT /communities/:id/chat-config support ─────────────────────────────────

const MAX_CHAT_CHANNEL_NAME_LENGTH = 100;

export type ChatChannelNameFieldUpdate =
  | { action: 'set'; value: string }
  | { action: 'clear' }
  | { action: 'skip' }
  | { action: 'invalid' }
  | { action: 'taken' };

/** Same set/clear/skip/invalid resolution as discordWebhook.ts's resolveWebhookField, plus
 *  'taken' when the (normalized) name is already registered — as this same channel type — to a
 *  different community. */
export async function resolveChatChannelNameField(
  raw: unknown,
  communityId: Types.ObjectId,
  channelType: ChatChannelType,
): Promise<ChatChannelNameFieldUpdate> {
  if (raw === undefined) return { action: 'skip' };
  if (typeof raw !== 'string') return { action: 'invalid' };

  const trimmed = raw.trim();
  if (!trimmed) return { action: 'clear' };
  if (trimmed.length > MAX_CHAT_CHANNEL_NAME_LENGTH) return { action: 'invalid' };

  const taken = await isChatChannelNameTaken(normalizeChatChannelName(trimmed), channelType, communityId);
  if (taken) return { action: 'taken' };
  return { action: 'set', value: trimmed };
}

/** Same set/clear/skip/invalid resolution as `resolveChatChannelNameField`, minus the
 *  uniqueness check — `displayName` is purely cosmetic (see ChatChannelName.displayName) so
 *  nothing else needs to stay globally unique for it. */
export function resolveDisplayNameField(raw: unknown): ChatChannelNameFieldUpdate {
  if (raw === undefined) return { action: 'skip' };
  if (typeof raw !== 'string') return { action: 'invalid' };

  const trimmed = raw.trim();
  if (!trimmed) return { action: 'clear' };
  if (trimmed.length > MAX_CHAT_CHANNEL_NAME_LENGTH) return { action: 'invalid' };
  return { action: 'set', value: trimmed };
}

/** Applies an already-validated ChatChannelNameFieldUpdate for `name` ('invalid'/'taken' are
 *  no-ops here — callers must have handled those before calling this), plus an optional
 *  `displayNameUpdate` applied in the same write. Uses `$set`/`$unset` rather than a full
 *  document replacement so setting one field never silently drops the other. */
export async function applyChatChannelNameUpdate(
  communityId: Types.ObjectId,
  channelType: ChatChannelType,
  update: ChatChannelNameFieldUpdate,
  displayNameUpdate: ChatChannelNameFieldUpdate = { action: 'skip' },
): Promise<void> {
  if (update.action === 'clear') {
    await ChatChannelName.deleteOne({ communityId, channelType });
    return;
  }

  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  if (update.action === 'set') {
    set.name = update.value;
    set.normalizedName = normalizeChatChannelName(update.value);
  }
  if (displayNameUpdate.action === 'set') set.displayName = displayNameUpdate.value;
  else if (displayNameUpdate.action === 'clear') unset.displayName = '';

  if (update.action === 'set') {
    // Upsert path: a fresh (or renamed) name is being set, so it's safe to create the doc if it
    // doesn't exist yet.
    await ChatChannelName.findOneAndUpdate(
      { communityId, channelType },
      {
        $set: { communityId, channelType, ...set },
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
      { upsert: true },
    );
  } else if (Object.keys(set).length || Object.keys(unset).length) {
    // name itself is unchanged ('skip') — only touch displayName, and only on a doc that already
    // exists (no name registered means there's nothing to attach a display name to).
    await ChatChannelName.updateOne(
      { communityId, channelType },
      { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    );
  }
}
