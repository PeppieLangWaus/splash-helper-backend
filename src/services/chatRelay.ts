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
 *  inconsistent underscore — that's genuinely how the plugin spells them.
 *
 *  RuneLite's own ChatMessageType splits an in-game clan chat message three ways depending on
 *  which of the (new, post-2022) clan system's channels it came from — CLAN_CHAT for the
 *  player's own clan, CLAN_GUEST_CHAT while viewing another clan as a guest, CLAN_GIM_CHAT for a
 *  Group Ironman clan — all three are the same "clan chat" concept from this backend's point of
 *  view, so all map to 'cc'. Missing the latter two used to mean a message from a guest/GIM clan
 *  channel simply didn't match any key here and got silently dropped as unparseable, which looked
 *  like "clan chat stopped being recognized" for anyone chatting in one of those. */
const MESSAGE_TYPE_TO_CHANNEL_TYPE: Record<string, ChatChannelType> = {
  FRIENDSCHAT: 'fc',
  CLAN_CHAT: 'cc',
  CLAN_GUEST_CHAT: 'cc',
  CLAN_GIM_CHAT: 'cc',
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
  /** The Friends Chat owner's RSN (`friendsChat.owner`), when the plugin sent one — never set for
   *  a 'cc' message. This, not `chatName`, is what a Friends Chat message is actually classified
   *  by; see resolveChatBinding and ChatChannelName's doc comment for why. */
  chatOwner?: string;
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
  // Left exactly as the plugin sends it - including any leading `<img=N>` mod/ironman-status tag
  // and, for a two-word RSN, an embedded U+00A0 (non-breaking space) - since the frontend parses
  // that tag for the status icon (chatIcons.ts's parsePlayerName) and a NBSP renders identically
  // to a normal space in HTML either way. Where a *clean* username is actually needed (resolving
  // !log/!pets against RuneProfile's/RuneLite's own API - services/itemLogResolver.ts), that
  // sanitization happens there instead, scoped to just that lookup rather than this display field.
  const sender = u.name.trim();

  // The chat name lives in whichever of friendsChat/clanChat matches this message's own declared
  // type — not just "whichever is present", so a message can't smuggle itself in under the wrong
  // container.
  const container = channelType === 'fc' ? r.friendsChat : r.clanChat;
  if (!container || typeof container !== 'object') return null;
  const c = container as Record<string, unknown>;
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > MAX_NAME_LENGTH) return null;
  const chatName = c.name.trim();
  const chatOwner = channelType === 'fc' && typeof c.owner === 'string' && c.owner.trim()
    && c.owner.length <= MAX_NAME_LENGTH
    ? c.owner.trim()
    : undefined;

  const rankInfo = channelType === 'fc'
    ? getFriendsChatRankInfo(typeof u.friendsChatRank === 'string' ? u.friendsChatRank : undefined)
    : parseClanRankInfo(u.clanRank);

  return {
    channelType,
    chatName,
    chatOwner,
    sender,
    message,
    rankInfo,
    sourceId: m.id,
    sourceTimestamp: m.timestamp,
    sourceType: m.type as string,
    edited,
  };
}

// ── Chat-name / chat-owner → community classification ───────────────────────

interface ChannelBinding {
  communityId: string;
  channelType: ChatChannelType;
}

/** What `resolveChatBinding` actually keyed the match on — see `syncFriendsChatIdentity`, which
 *  branches on this to either self-heal a drifted FC name or capture an owner for the first time. */
export interface ResolvedChannelBinding extends ChannelBinding {
  matchedBy: 'owner' | 'name';
}

const CACHE_TTL_MS = process.env.CHAT_RELAY_CACHE_TTL_MS !== undefined
  ? Number(process.env.CHAT_RELAY_CACHE_TTL_MS)
  : 15_000;

// Keyed by `${channelType}|${normalizedName}` rather than name alone — FC and CC are separate
// in-game namespaces, so the same name can legitimately be registered as both at once (even to
// different communities); collapsing them onto one key would make one silently shadow the other.
// Only holds 'cc' entries plus any 'fc' entries not yet captured onto owner-based trust (see
// ChatChannelName's doc comment) — a captured 'fc' entry lives in `ownerBindingCache` instead.
let bindingCache = new Map<string, ChannelBinding>();
// Friends-Chat-only: keyed by normalizedOwnerName alone (owner is a single global namespace,
// unlike name which is scoped per channelType).
let ownerBindingCache = new Map<string, ChannelBinding>();
let bindingCacheAt = 0;

function bindingCacheKey(normalizedName: string, channelType: ChatChannelType): string {
  return `${channelType}|${normalizedName}`;
}

async function refreshBindingCacheIfStale(): Promise<void> {
  const now = Date.now();
  if (now - bindingCacheAt < CACHE_TTL_MS) return;
  bindingCacheAt = now;

  try {
    const entries = await ChatChannelName.find(
      {},
      { normalizedName: 1, normalizedOwnerName: 1, communityId: 1, channelType: 1 },
    ).lean();
    const nextBindingCache = new Map<string, ChannelBinding>();
    const nextOwnerBindingCache = new Map<string, ChannelBinding>();
    for (const e of entries) {
      const binding: ChannelBinding = { communityId: e.communityId.toString(), channelType: e.channelType };
      if (e.channelType === 'fc' && e.normalizedOwnerName) {
        nextOwnerBindingCache.set(e.normalizedOwnerName, binding);
      } else if (e.normalizedName) {
        nextBindingCache.set(bindingCacheKey(e.normalizedName, e.channelType), binding);
      }
    }
    bindingCache = nextBindingCache;
    ownerBindingCache = nextOwnerBindingCache;
  } catch (err) {
    logWarn(`Failed to refresh chat-relay binding cache: ${(err as Error).message}`);
  }
}

/**
 * Resolves a parsed message to the community that registered its Friends/Clan Chat, or null if no
 * community currently claims it. A Friends Chat message with a `chatOwner` is matched against that
 * owner first — the trust anchor for any FC that has one on file, since (unlike its name) an
 * owner's RSN doesn't change when they rename the chat — falling back to matching by `chatName`
 * only for an FC that hasn't captured an owner yet (or a message that didn't carry one). Clan Chat
 * is always matched by name.
 */
export async function resolveChatBinding(
  chatName: string,
  channelType: ChatChannelType,
  chatOwner?: string,
): Promise<ResolvedChannelBinding | null> {
  await refreshBindingCacheIfStale();

  if (channelType === 'fc' && chatOwner) {
    const byOwner = ownerBindingCache.get(normalizeChatChannelName(chatOwner));
    if (byOwner) return { ...byOwner, matchedBy: 'owner' };
  }

  const byName = bindingCache.get(bindingCacheKey(normalizeChatChannelName(chatName), channelType));
  return byName ? { ...byName, matchedBy: 'name' } : null;
}

/**
 * Keeps a community's registered Friends Chat identity in sync with live traffic, now that a
 * message has been positively attributed to it — this is the whole reason FC classification
 * doesn't need `name` to stay fixed once an owner is on file:
 *  - Matched by **owner** (steady state): the owner is free to rename their FC at any time without
 *    breaking anything, but the registered `name`/`normalizedName` — shown back in chat-config, the
 *    chatbox picker, and the Discord relay line prefix — would otherwise silently go stale. Write
 *    the live name back whenever it's drifted from what's on file.
 *  - Matched by **name** (this FC hasn't captured an owner yet — either registered before this
 *    field existed, or the owner hasn't re-saved chat-config since): if this particular message
 *    happens to carry an owner value, capture it now. From that point on this community's FC no
 *    longer depends on its name staying fixed at all.
 * Best-effort by design: a failure here (including a duplicate-key race against the
 * `normalizedOwnerName` index, if two communities' messages somehow ever claimed the same owner)
 * just leaves the name/owner stale until the next message — it must never fail the relay call that
 * triggered it.
 */
async function syncFriendsChatIdentity(
  communityId: string,
  parsed: Pick<ParsedChatMessage, 'chatName' | 'chatOwner'>,
  matchedBy: 'owner' | 'name',
): Promise<void> {
  try {
    if (matchedBy === 'owner') {
      const normalizedLiveName = normalizeChatChannelName(parsed.chatName);
      await ChatChannelName.updateOne(
        { communityId, channelType: 'fc', normalizedName: { $ne: normalizedLiveName } },
        { $set: { name: parsed.chatName, normalizedName: normalizedLiveName } },
      );
    } else if (parsed.chatOwner) {
      await ChatChannelName.updateOne(
        { communityId, channelType: 'fc', ownerName: { $exists: false } },
        {
          $set: {
            ownerName: parsed.chatOwner,
            normalizedOwnerName: normalizeChatChannelName(parsed.chatOwner),
            // Leaving name-trust behind now that an owner is on file — see ChatChannelName's
            // `nameTrustEligible` doc comment for why this has to be an explicit flag flip rather
            // than just the presence of `ownerName`.
            nameTrustEligible: false,
          },
        },
      );
    }
  } catch (err) {
    logWarn(`Failed to sync Friends Chat identity for community ${communityId}: ${(err as Error).message}`);
  }
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

  // See ChatChannelName's doc comment + resolveChatBinding for why Friends Chat is trusted by
  // owner (once captured) rather than name, and Clan Chat still by (name, type) together. A name
  // or owner registered as/for one type but claimed as the other (misconfigured or spoofed)
  // simply won't resolve, and is dropped the same as one nobody has registered at all.
  const binding = await resolveChatBinding(parsed.chatName, parsed.channelType, parsed.chatOwner);
  if (!binding) {
    return { status: 'dropped', reason: 'unrecognized-source' };
  }

  const community = await Community.findById(binding.communityId);
  if (!community) return { status: 'dropped', reason: 'unrecognized-source' };

  if (binding.channelType === 'fc') {
    // Awaited (not fire-and-forget) so the identity update is visible by the time this call
    // resolves, but internally best-effort — see syncFriendsChatIdentity's own try/catch, which
    // never lets this delay-turned-failure drop the message it rode in on.
    await syncFriendsChatIdentity(binding.communityId, parsed, binding.matchedBy);
  }

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

  // `!log <page>`/`!log missing <page>`/`!pets` get their real item data resolved here, from
  // RuneProfile's own API (services/itemLogResolver.ts) — not from any `<img=N>` tag the message
  // text might contain, which is a client-local, per-viewer-session sprite index with no relation
  // to the real item id. This does add a bounded network round trip before responding to the
  // relay POST, but only for a message that matches one of these two commands; every other chat
  // line is entirely unaffected. On success, the broadcast `message` becomes the resolution's own
  // clean summary (e.g. "Cyclopes (8/8):") in place of the raw command/plugin-rewritten text —
  // `forwardChatWebhookPayload` above already ran with the original text, unaffected by this.
  const itemLogCommand = detectItemLogCommand(parsed.message);
  const resolution = itemLogCommand ? await resolveItemLogCommand(parsed.sender, itemLogCommand) : null;

  broadcastChatMessage(
    binding.communityId,
    binding.channelType,
    parsed.sender,
    resolution ? resolution.summary : parsed.message,
    parsed.rankInfo ?? undefined,
    {
      id: parsed.sourceId,
      timestamp: parsed.sourceTimestamp,
      type: parsed.sourceType,
      edited: parsed.edited,
    },
    resolution?.items,
    resolution?.showQuantities,
  );

  log(`Chat relay: ${binding.channelType} message for community ${binding.communityId} from ${parsed.sender}`);
  return { status: 'forwarded', communityId: binding.communityId, channelType: binding.channelType };
}

/** Validates a candidate FC/CC name isn't already registered — as that *same* channel type — to a
 *  *different* community, for the PUT /communities/:id/chat-config route. Registering the same
 *  name to the same community again (e.g. re-saving unchanged settings) is allowed, and so is an
 *  FC and a CC sharing a name (they're separate in-game namespaces — see ChatChannelName).
 *  Generic over both channel types, but the route below only actually calls this for `'cc'` now —
 *  Friends Chat registration goes through `resolveChatChannelOwnerField` instead (see the "Friends
 *  Chat owner registration" section further down). */
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
    // This path is CC-only in practice (see this function's doc comment) — a CC doc never has an
    // `ownerName`, so it's always name-trust eligible. See ChatChannelName's `nameTrustEligible`
    // doc comment for why this has to be an explicit flag rather than derived from `ownerName`.
    set.nameTrustEligible = true;
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

// ── Friends Chat owner registration (PUT /communities/:id/chat-config) ──────
//
// Unlike Clan Chat, which is still registered and matched by name via the two helpers above,
// Friends Chat is registered by its **owner's RSN** — see ChatChannelName's doc comment for why.
// The counterparts below are FC-only (no channelType parameter) and never touch `name`; that field
// is written only by chatRelay's own `syncFriendsChatIdentity`, off live traffic.

/** Validates a candidate FC owner RSN isn't already registered to a *different* community, for the
 *  PUT /communities/:id/chat-config route. Re-registering the same owner to the same community
 *  again (e.g. re-saving unchanged settings) is allowed. */
export async function isChatChannelOwnerTaken(
  normalizedOwnerName: string,
  byOtherThanCommunityId: Types.ObjectId,
): Promise<boolean> {
  const existing = await ChatChannelName.findOne({ normalizedOwnerName, channelType: 'fc' }).lean();
  return !!existing && !existing.communityId.equals(byOtherThanCommunityId);
}

/** Same set/clear/skip/invalid/taken resolution as `resolveChatChannelNameField`, but for the FC
 *  owner field instead of a name. */
export async function resolveChatChannelOwnerField(
  raw: unknown,
  communityId: Types.ObjectId,
): Promise<ChatChannelNameFieldUpdate> {
  if (raw === undefined) return { action: 'skip' };
  if (typeof raw !== 'string') return { action: 'invalid' };

  const trimmed = raw.trim();
  if (!trimmed) return { action: 'clear' };
  if (trimmed.length > MAX_CHAT_CHANNEL_NAME_LENGTH) return { action: 'invalid' };

  const taken = await isChatChannelOwnerTaken(normalizeChatChannelName(trimmed), communityId);
  if (taken) return { action: 'taken' };
  return { action: 'set', value: trimmed };
}

/** Applies an already-validated ChatChannelNameFieldUpdate for the FC `ownerName`
 *  ('invalid'/'taken' are no-ops here — callers must have handled those before calling this),
 *  plus an optional `displayNameUpdate` applied in the same write. Deliberately never touches
 *  `name`/`normalizedName`: those are populated (and kept in sync) by chatRelay's own
 *  `syncFriendsChatIdentity` off the community's first/next relayed message, not by this route. */
export async function applyChatChannelOwnerUpdate(
  communityId: Types.ObjectId,
  update: ChatChannelNameFieldUpdate,
  displayNameUpdate: ChatChannelNameFieldUpdate = { action: 'skip' },
): Promise<void> {
  if (update.action === 'clear') {
    await ChatChannelName.deleteOne({ communityId, channelType: 'fc' });
    return;
  }

  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  if (update.action === 'set') {
    set.ownerName = update.value;
    set.normalizedOwnerName = normalizeChatChannelName(update.value);
    // An owner is now on file, so this doc leaves name-trust behind (see ChatChannelName's
    // `nameTrustEligible` doc comment for why this has to be an explicit flag flip rather than
    // just the presence of `ownerName`).
    set.nameTrustEligible = false;
  }
  if (displayNameUpdate.action === 'set') set.displayName = displayNameUpdate.value;
  else if (displayNameUpdate.action === 'clear') unset.displayName = '';

  if (update.action === 'set') {
    // Upsert path: a fresh (or changed) owner is being set, so it's safe to create the doc if it
    // doesn't exist yet.
    await ChatChannelName.findOneAndUpdate(
      { communityId, channelType: 'fc' },
      {
        $set: { communityId, channelType: 'fc', ...set },
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
      { upsert: true },
    );
  } else if (Object.keys(set).length || Object.keys(unset).length) {
    // owner itself is unchanged ('skip') — only touch displayName, and only on a doc that already
    // exists (no owner registered means there's nothing to attach a display name to).
    await ChatChannelName.updateOne(
      { communityId, channelType: 'fc' },
      { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    );
  }
}
