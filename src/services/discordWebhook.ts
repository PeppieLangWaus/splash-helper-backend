import { WebhookClient, EmbedBuilder } from 'discord.js';
import { SplashEntry } from '../types';

const DISCORD_EMBED_LIMIT = 10;

// A single sequential queue of async tasks, shared by both the batch notifier and the
// single-session upsert notifier, so all outgoing requests to a webhook stay ordered
// (and rate-limit-friendly) regardless of which caller enqueued them.
const queue: Array<() => Promise<void>> = [];
let processing = false;

function enqueue(task: () => Promise<void>): void {
  queue.push(task);
  if (!processing) {
    void processQueue();
  }
}

async function processQueue(): Promise<void> {
  processing = true;

  while (queue.length > 0) {
    const task = queue.shift()!;
    await task();
  }

  processing = false;
}

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
  enqueue(() => sendWebhook(webhookUrl, username, entries));
}

async function sendWebhook(webhookUrl: string, username: string, entries: SplashEntry[]): Promise<void> {
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

/**
 * Post a single archived-session notification, or edit a previous one in place when
 * `existingMessageId` is given — e.g. a session that was finalized on a brief inactivity
 * timeout, then resumed and finalized again with more casts/XP, updates its original post
 * instead of adding a duplicate. Falls back to posting a new message if the edit target no
 * longer exists (e.g. manually deleted from Discord).
 *
 * Returns the id of the message that now reflects this entry, or undefined if no webhook is
 * configured or the request failed.
 */
export function upsertArchivedSessionNotification(
  webhookUrl: string,
  username: string,
  entry: SplashEntry,
  existingMessageId?: string,
): Promise<string | undefined> {
  if (!webhookUrl) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    enqueue(async () => {
      const client = getWebhookClient(webhookUrl);
      const embed = buildSessionEmbed(username, entry);

      if (existingMessageId) {
        try {
          const msg = await client.editMessage(existingMessageId, { embeds: [embed] });
          resolve(msg.id);
          return;
        } catch (err) {
          console.warn(
            `Failed to edit archived-session message ${existingMessageId} for "${username}", posting a new one instead:`,
            (err as Error).message,
          );
        }
      }

      try {
        const msg = await client.send({ embeds: [embed] });
        resolve(msg.id);
      } catch (err) {
        console.error(`Discord webhook error for "${username}":`, (err as Error).message);
        resolve(undefined);
      }
    });
  });
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
