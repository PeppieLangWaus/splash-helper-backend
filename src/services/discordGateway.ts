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

let embedDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function updateActiveSessionsEmbed(sessions: ActiveSessionState[]): void {
  if (!WEBHOOK_URL) return;

  if (embedDebounceTimer) clearTimeout(embedDebounceTimer);
  embedDebounceTimer = setTimeout(() => {
    void patchActiveEmbed(sessions);
    embedDebounceTimer = null;
  }, 2000);
}

/**
 * Called when a new session is announced (SESSION_START). Rather than editing
 * the existing active-sessions message in place, posts a divider and a fresh
 * message so a new session starting is visually distinct in the channel's
 * history, instead of silently blending into edits of the old message.
 */
export function announceNewSession(sessions: ActiveSessionState[]): void {
  if (!WEBHOOK_URL) return;

  if (embedDebounceTimer) clearTimeout(embedDebounceTimer);
  embedDebounceTimer = setTimeout(() => {
    void postNewActiveEmbed(sessions);
    embedDebounceTimer = null;
  }, 2000);
}

async function postNewActiveEmbed(sessions: ActiveSessionState[]): Promise<void> {
  const client = getWebhookClient();
  if (!client) return;

  try {
    await client.send({ content: '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯' });
  } catch (err) {
    console.error('Failed to send new-session divider:', (err as Error).message);
  }

  // Force the next patch to send a brand-new message rather than editing the
  // old one, so it lands right after the divider.
  activeMessageId = null;
  await patchActiveEmbed(sessions);
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
        value: `Spell: ${d.spell} | Players: ${d.pickpocketerCount} | Duration: ${duration}`,
        inline: false,
      });
    }
  } else {
    embed.addFields({ name: 'No active splashers', value: 'Check back later!', inline: false });
  }

  return embed;
}
