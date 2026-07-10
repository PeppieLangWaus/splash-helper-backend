import { WebhookClient, EmbedBuilder } from 'discord.js';
import { SplashEntry } from '../types';

interface QueueItem {
  webhookUrl: string;
  username: string;
  entries: SplashEntry[];
}

const DISCORD_EMBED_LIMIT = 10;
const queue: QueueItem[] = [];
let processing = false;

// Cache WebhookClient instances by URL to reuse connections
const webhookClients = new Map<string, WebhookClient>();

function getWebhookClient(url: string): WebhookClient {
  let client = webhookClients.get(url);
  if (!client) {
    client = new WebhookClient({ url });
    webhookClients.set(url, client);
  }
  return client;
}

export function enqueueWebhookNotification(
  webhookUrl: string,
  username: string,
  entries: SplashEntry[],
): void {
  if (!webhookUrl || entries.length === 0) return;
  queue.push({ webhookUrl, username, entries });
  if (!processing) {
    void processQueue();
  }
}

async function processQueue(): Promise<void> {
  processing = true;

  while (queue.length > 0) {
    const item = queue.shift()!;
    await sendWebhook(item);
  }

  processing = false;
}

async function sendWebhook(item: QueueItem): Promise<void> {
  const { webhookUrl, username, entries } = item;
  const client = getWebhookClient(webhookUrl);

  for (let i = 0; i < entries.length; i += DISCORD_EMBED_LIMIT) {
    const chunk = entries.slice(i, i + DISCORD_EMBED_LIMIT);
    const embeds = chunk.map((entry) => buildSessionEmbed(username, entry));

    try {
      await client.send({ embeds });
    } catch (err) {
      console.error(`Discord webhook error for "${username}":`, (err as Error).message);
    }
  }
}

function buildSessionEmbed(username: string, entry: SplashEntry): EmbedBuilder {
  const d = entry.session;
  const xpGained = d.currentMagicXp - d.startMagicXp;
  const sessionDate = new Date(entry.createdTimestamp).toUTCString();

  return new EmbedBuilder()
    .setTitle(`🎣 Archived session — ${username}`)
    .setColor(0x1abc9c)
    .addFields(
      { name: 'Spell', value: d.spell, inline: true },
      { name: 'World', value: String(d.world), inline: true },
      { name: 'Spells Cast', value: d.spellsCast.toLocaleString(), inline: true },
      { name: 'Magic XP Gained', value: xpGained.toLocaleString(), inline: true },
      { name: 'Rune Cost (gp)', value: d.runeCostGp.toLocaleString(), inline: true },
      { name: 'Knight Movements', value: d.knightMovements.toLocaleString(), inline: true },
      { name: 'Avg Players', value: d.averagePlayerCount.toFixed(1), inline: true },
      { name: 'Sticky Knight', value: d.stickyKnight ? 'Yes' : 'No', inline: true },
      { name: 'Date', value: sessionDate, inline: false },
    )
    .setFooter({ text: 'Splash Helper' })
    .setTimestamp(new Date(entry.createdTimestamp));
}
