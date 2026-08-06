import { WebhookClient, EmbedBuilder } from 'discord.js';
import { ActiveSessionState } from '../types';
import { Community } from '../models/Community';
import { User } from '../models/User';
import { DiscordEmbedMessage } from '../models/DiscordEmbedMessage';

const WEBHOOK_URL = process.env.DISCORD_ACTIVE_WEBHOOK_URL ?? '';

// How often a single active-sessions message gets edited, in ms. Configurable
// via env so it can be tuned without a code change; defaults within the
// 15-30s range Discord rate limits comfortably tolerate. Shared by the
// site-wide embed and every per-community/per-splasher embed.
const EMBED_UPDATE_INTERVAL_MS = Number(process.env.DISCORD_EMBED_UPDATE_INTERVAL_MS) || 20_000;

// How long a community's/splasher's { webhookUrl, members } snapshot is trusted before
// re-querying the DB. Session updates can arrive many times a second across many
// connections, so this keeps that off the hot path. (Number() || default would treat an
// explicit 0 as "unset", so this is checked for explicitly — tests rely on being able to
// disable the cache entirely.)
const CONFIG_CACHE_TTL_MS = process.env.DISCORD_COMMUNITY_CACHE_TTL_MS !== undefined
  ? Number(process.env.DISCORD_COMMUNITY_CACHE_TTL_MS)
  : 15_000;

interface EmbedTarget {
  /** Stable identifier for this embed's scope ('global', `community:<id>`,
   *  `splasher:<id>`), used as the persistence key — see loadPersistedMessageId. */
  key: string;
  title: string;
  webhookUrl: string;
}

interface EmbedState {
  target: EmbedTarget;
  client: WebhookClient;
  activeMessageId: string | null;
  // Resolves once activeMessageId has been (attempted to be) loaded from the DB, so the
  // very first patchActiveEmbed() call after a restart waits for it instead of racing
  // ahead and posting a duplicate message before the persisted id is known.
  loaded: Promise<void>;
  lastEmbedUpdate: number;
  pendingSessions: ActiveSessionState[] | null;
  pendingTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Loads a previously-persisted message id for this embed, so a redeploy/restart resumes
 * editing the same Discord message instead of losing track of it and posting a new one.
 * Ignored if the persisted record belongs to a since-changed webhook URL (e.g. the
 * community/splasher rotated their webhook) — that message is no longer reachable via the
 * current client and shouldn't be edited.
 */
async function loadPersistedMessageId(target: EmbedTarget): Promise<string | null> {
  try {
    const doc = await DiscordEmbedMessage.findOne({ key: target.key }).lean();
    if (!doc || doc.webhookUrl !== target.webhookUrl) return null;
    return doc.messageId;
  } catch (err) {
    console.error(`Failed to load persisted embed message id for "${target.key}":`, (err as Error).message);
    return null;
  }
}

/** Persists (or, when messageId is null, clears) the message id so it survives a restart. */
async function persistMessageId(target: EmbedTarget, messageId: string | null): Promise<void> {
  try {
    if (messageId) {
      await DiscordEmbedMessage.findOneAndUpdate(
        { key: target.key },
        { key: target.key, webhookUrl: target.webhookUrl, messageId },
        { upsert: true },
      );
    } else {
      await DiscordEmbedMessage.deleteOne({ key: target.key });
    }
  } catch (err) {
    console.error(`Failed to persist embed message id for "${target.key}":`, (err as Error).message);
  }
}

function createEmbedState(target: EmbedTarget): EmbedState {
  const state: EmbedState = {
    target,
    client: new WebhookClient({ url: target.webhookUrl }),
    activeMessageId: null,
    loaded: Promise.resolve(),
    lastEmbedUpdate: 0,
    pendingSessions: null,
    pendingTimer: null,
  };
  state.loaded = loadPersistedMessageId(target).then((id) => {
    state.activeMessageId = id;
  });
  return state;
}

const globalState: EmbedState | null = WEBHOOK_URL
  ? createEmbedState({ key: 'global', title: 'Active Splashers', webhookUrl: WEBHOOK_URL })
  : null;

// One throttled embed state per community/splasher that currently has an active-sessions
// webhook configured, keyed by the Community/User _id (as a string).
const communityStates = new Map<string, EmbedState>();
const splasherStates = new Map<string, EmbedState>();

interface WebhookConfig {
  id: string;
  webhookUrl: string;
}

interface CommunityWebhookConfig extends WebhookConfig {
  name: string;
  memberIds: Set<string>;
}

interface SplasherWebhookConfig extends WebhookConfig {
  username: string;
}

let communityConfigCache: CommunityWebhookConfig[] = [];
let splasherConfigCache: SplasherWebhookConfig[] = [];
let configCacheAt = 0;

async function refreshConfigsIfStale(): Promise<void> {
  const now = Date.now();
  if (now - configCacheAt < CONFIG_CACHE_TTL_MS) return;
  configCacheAt = now;

  try {
    const [communities, splashers] = await Promise.all([
      Community.find(
        { discordActiveWebhookUrl: { $exists: true, $nin: [null, ''] } },
        { name: 1, discordActiveWebhookUrl: 1, memberUserIds: 1 },
      ).lean(),
      User.find(
        { discordActiveWebhookUrl: { $exists: true, $nin: [null, ''] } },
        { username: 1, discordActiveWebhookUrl: 1 },
      ).lean(),
    ]);
    communityConfigCache = communities.map((c) => ({
      id: c._id.toString(),
      name: c.name,
      webhookUrl: c.discordActiveWebhookUrl as string,
      memberIds: new Set(c.memberUserIds.map((m) => m.toString())),
    }));
    splasherConfigCache = splashers.map((u) => ({
      id: u._id.toString(),
      username: u.username,
      webhookUrl: u.discordActiveWebhookUrl as string,
    }));
  } catch (err) {
    console.error('Failed to load active-sessions webhook configs:', (err as Error).message);
  }
}

/**
 * Creates/reuses one EmbedState per config and drops states for configs that no longer
 * exist (webhook cleared, or the community/splasher itself was deleted) so a stale config
 * doesn't keep editing a now-orphaned message.
 */
function reconcileStates<T extends WebhookConfig>(
  states: Map<string, EmbedState>,
  configs: T[],
  keyPrefix: string,
  titleFor: (config: T) => string,
): void {
  const configuredIds = new Set(configs.map((c) => c.id));
  for (const id of states.keys()) {
    if (!configuredIds.has(id)) states.delete(id);
  }

  for (const config of configs) {
    const existing = states.get(config.id);
    if (!existing || existing.target.webhookUrl !== config.webhookUrl) {
      states.set(
        config.id,
        createEmbedState({ key: `${keyPrefix}:${config.id}`, title: titleFor(config), webhookUrl: config.webhookUrl }),
      );
    }
  }
}

// ── Active session embed update ───────────────────────────────────────────────

/**
 * Throttled update of every active-sessions message this splasher pool feeds: the single
 * site-wide message (if DISCORD_ACTIVE_WEBHOOK_URL is set), one message per community that
 * has its own active-sessions webhook configured (scoped to that community's members), and
 * one personal message per splasher who set their own active-sessions webhook (scoped to
 * just their own session). Each message is edited at most once per EMBED_UPDATE_INTERVAL_MS,
 * with the most recent session state always flushed on the trailing edge.
 */
export function updateActiveSessionsEmbed(sessions: ActiveSessionState[]): void {
  if (globalState) {
    scheduleEmbedUpdate(globalState, sessions);
  }
  void updateScopedEmbeds(sessions);
}

async function updateScopedEmbeds(sessions: ActiveSessionState[]): Promise<void> {
  await refreshConfigsIfStale();

  reconcileStates(communityStates, communityConfigCache, 'community', (c) => `Active Splashers — ${c.name}`);
  for (const config of communityConfigCache) {
    const state = communityStates.get(config.id)!;
    const memberSessions = sessions.filter((s) => config.memberIds.has(s.userId));
    scheduleEmbedUpdate(state, memberSessions);
  }

  reconcileStates(splasherStates, splasherConfigCache, 'splasher', (c) => `Active Session — ${c.username}`);
  for (const config of splasherConfigCache) {
    const state = splasherStates.get(config.id)!;
    const ownSession = sessions.filter((s) => s.userId === config.id);
    scheduleEmbedUpdate(state, ownSession);
  }
}

function scheduleEmbedUpdate(state: EmbedState, sessions: ActiveSessionState[]): void {
  const now = Date.now();
  const elapsed = now - state.lastEmbedUpdate;

  if (elapsed >= EMBED_UPDATE_INTERVAL_MS) {
    state.lastEmbedUpdate = now;
    void patchActiveEmbed(state, sessions);
    return;
  }

  state.pendingSessions = sessions;
  if (state.pendingTimer) return;

  state.pendingTimer = setTimeout(() => {
    state.pendingTimer = null;
    state.lastEmbedUpdate = Date.now();
    const toSend = state.pendingSessions;
    state.pendingSessions = null;
    if (toSend) void patchActiveEmbed(state, toSend);
  }, EMBED_UPDATE_INTERVAL_MS - elapsed);
}

async function patchActiveEmbed(state: EmbedState, sessions: ActiveSessionState[]): Promise<void> {
  // Wait for the persisted message id (if any) to finish loading before deciding whether
  // to edit or send — otherwise the first update after a restart could race ahead and post
  // a duplicate message before the DB lookup resolves.
  await state.loaded;

  const activeSessions = sessions.filter((s) => s.authenticated && s.sessionData !== null);
  const embed = buildActiveSessionsEmbed(state.target.title, activeSessions);

  try {
    if (state.activeMessageId) {
      // Edit the existing message
      await state.client.editMessage(state.activeMessageId, { embeds: [embed] });
    } else {
      // Send a new message, remember its ID, and persist it so a future restart can
      // keep editing this same message instead of losing track of it.
      const msg = await state.client.send({ embeds: [embed] });
      state.activeMessageId = msg.id;
      await persistMessageId(state.target, msg.id);
      console.log(`Discord active sessions message created (${state.target.title}): ${state.activeMessageId}`);
    }
  } catch (err: unknown) {
    const apiErr = err as { code?: number };
    if (apiErr.code === 10008 && state.activeMessageId) {
      // Unknown Message — the old message was deleted; send a new one
      console.warn(`Active sessions message was deleted (${state.target.title}), sending a new one`);
      state.activeMessageId = null;
      await persistMessageId(state.target, null);
      await patchActiveEmbed(state, sessions);
    } else {
      console.error(`Failed to update active sessions embed (${state.target.title}):`, (err as Error).message);
    }
  }
}

function buildActiveSessionsEmbed(title: string, sessions: ActiveSessionState[]): EmbedBuilder {
  const now = Date.now();

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x3498db)
    .setThumbnail('https://cdn.discordapp.com/icons/1489687499981979741/c99d3edc2be96bb7a18673a62a3561b8.webp?size=80&quality=lossless')
    .setFooter({ text: `Splash Helper • ${sessions.length} active` })
    .setTimestamp();

  if (sessions.length > 0) {
    for (const s of sessions) {
      const d = s.sessionData!;
      const durationMs = now - new Date(d.startTime).getTime();
      const hours = Math.floor(durationMs / 3_600_000);
      const minutes = Math.floor((durationMs % 3_600_000) / 60_000);
      const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      embed.addFields({
        name: `${d.playerName} — World ${d.world}`,
        value: `Spell: ${d.spell} | Players: ${d.averagePlayerCount} avg | Duration: ${duration}`,
        inline: false,
      });
    }
  } else {
    embed.addFields({ name: 'No active splashers', value: 'Check back later!', inline: false });
  }

  return embed;
}
