import mongoose, { Document, Schema } from 'mongoose';

/**
 * Persists the Discord message id of a live-edited active-sessions embed (the site-wide
 * one, plus one per community/splasher that has its own active-sessions webhook), so a
 * backend redeploy/restart can keep editing the same message instead of losing track of
 * it and posting a fresh one every time. `key` is a stable identifier for the embed's
 * scope: 'global', `community:<Community _id>`, or `splasher:<User _id>`.
 *
 * `webhookUrl` is stored alongside so a stale record left behind by a since-changed
 * webhook is never mistaken for a live one — see discordGateway.ts's load/persist helpers.
 */
export interface IDiscordEmbedMessage extends Document {
  key: string;
  webhookUrl: string;
  messageId: string;
}

const DiscordEmbedMessageSchema = new Schema<IDiscordEmbedMessage>(
  {
    key: { type: String, required: true, unique: true },
    webhookUrl: { type: String, required: true },
    messageId: { type: String, required: true },
  },
  { timestamps: false },
);

export const DiscordEmbedMessage = mongoose.model<IDiscordEmbedMessage>(
  'DiscordEmbedMessage',
  DiscordEmbedMessageSchema,
);
