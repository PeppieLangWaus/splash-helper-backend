import { WebhookClient, EmbedBuilder } from 'discord.js';
import { ActiveSessionState } from '../types';

const WEBHOOK_URL = process.env.DISCORD_ACTIVE_WEBHOOK_URL ?? '';

let webhookClient: WebhookClient | null = null;
let activeMessageId: string | null = null;

function getWebhookClient(): WebhookClient | null {
  if (!WEBHOOK_URL) return null;
  if (!webhookClient) {
    webhookClient = new WebhookClient({ url: WEBHOOK_URL });
  }
  return webhookClient;
}

// ── Active session embed update ───────────────────────────────────────────────

// How often the single active-sessions message gets edited, in ms. Configurable
// via env so it can be tuned without a code change; defaults within the
// 15-30s range Discord rate limits comfortably tolerate.
const EMBED_UPDATE_INTERVAL_MS = Number(process.env.DISCORD_EMBED_UPDATE_INTERVAL_MS) || 20_000;

let lastEmbedUpdate = 0;
let pendingSessions: ActiveSessionState[] | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Throttled update of the single active-sessions message: edits happen at
 * most once per EMBED_UPDATE_INTERVAL_MS, but the most recent session state
 * always gets flushed on the trailing edge so nothing is lost between edits.
 */
export function updateActiveSessionsEmbed(sessions: ActiveSessionState[]): void {
  if (!WEBHOOK_URL) return;

  const now = Date.now();
  const elapsed = now - lastEmbedUpdate;

  if (elapsed >= EMBED_UPDATE_INTERVAL_MS) {
    lastEmbedUpdate = now;
    void patchActiveEmbed(sessions);
    return;
  }

  pendingSessions = sessions;
  if (pendingTimer) return;

  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    lastEmbedUpdate = Date.now();
    const toSend = pendingSessions;
    pendingSessions = null;
    if (toSend) void patchActiveEmbed(toSend);
  }, EMBED_UPDATE_INTERVAL_MS - elapsed);
}

async function patchActiveEmbed(sessions: ActiveSessionState[]): Promise<void> {
  const client = getWebhookClient();
  if (!client) return;

  const activeSessions = sessions.filter((s) => s.authenticated && s.sessionData !== null);
  const embed = buildActiveSessionsEmbed(activeSessions);

  try {
    if (activeMessageId) {
      // Edit the existing message
      await client.editMessage(activeMessageId, { embeds: [embed] });
    } else {
      // Send a new message and remember its ID
      const msg = await client.send({ embeds: [embed] });
      activeMessageId = msg.id;
      console.log(`Discord active sessions message created: ${activeMessageId}`);
    }
  } catch (err: unknown) {
    const apiErr = err as { code?: number };
    if (apiErr.code === 10008 && activeMessageId) {
      // Unknown Message — the old message was deleted; send a new one
      console.warn('Active sessions message was deleted, sending a new one');
      activeMessageId = null;
      await patchActiveEmbed(sessions);
    } else {
      console.error('Failed to update active sessions embed:', (err as Error).message);
    }
  }
}

function buildActiveSessionsEmbed(sessions: ActiveSessionState[]): EmbedBuilder {
  const now = Date.now();

  const embed = new EmbedBuilder()
    .setTitle('Active Splashers')
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
