import mongoose, { Document, Schema, Types } from 'mongoose';

export type ChatChannelType = 'fc' | 'cc';

/**
 * Maps an in-game Friends Chat / Clan Chat name to the community that owns it, so the global
 * chat-relay endpoint (chat.splasher.help / chat.ardy.host — see routes/chatRelay.ts) can figure
 * out which community a message belongs to from its content alone, with no per-community URL or
 * token involved. One document per (community, channelType) pair — a community has at most one
 * FC name and one CC name registered at a time.
 *
 * `normalizedName` is what lookups and the uniqueness constraint use (case-insensitive, trimmed);
 * `name` keeps the owner's original casing for display back in their community settings.
 */
export interface IChatChannelName extends Document {
  communityId: Types.ObjectId;
  channelType: ChatChannelType;
  name: string;
  normalizedName: string;
  /** Owner-chosen display name shown in the chatbox instead of `name` — mainly for Friends Chat,
   *  whose in-game name is inherently tied to the owner's RSN (see point 4 in the chatbox
   *  feature notes). Optional; unset falls back to `name` wherever it's shown. No uniqueness
   *  constraint (unlike `name`/`normalizedName`) since it's purely cosmetic. */
  displayName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ChatChannelNameSchema = new Schema<IChatChannelName>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: 'Community', required: true },
    channelType: { type: String, enum: ['fc', 'cc'], required: true },
    name: { type: String, required: true, trim: true },
    normalizedName: { type: String, required: true },
    displayName: { type: String, trim: true },
  },
  { timestamps: true },
);

// A (name, channelType) pair can only ever point at one community — this is the entire trust
// mechanism the relay's classification relies on, so it must be enforced at the DB level, not
// just in the route. Deliberately *not* unique on normalizedName alone: Friends Chats and Clan
// Chats are separate in-game namespaces, so an FC and a CC legitimately can share a name (even
// across two different communities) without colliding.
ChatChannelNameSchema.index({ normalizedName: 1, channelType: 1 }, { unique: true });
// One FC and one CC registration per community; re-registering the same type replaces it.
ChatChannelNameSchema.index({ communityId: 1, channelType: 1 }, { unique: true });

export const ChatChannelName = mongoose.model<IChatChannelName>('ChatChannelName', ChatChannelNameSchema);

/**
 * One-time startup migration: replaces the old `{ normalizedName: 1 }` unique index (which made
 * an FC and a CC collide whenever they shared a name — see the compound index above) with the
 * current `{ normalizedName: 1, channelType: 1 }` one. Mongoose's default autoIndex only *adds*
 * indexes newly declared in the schema; it never drops ones the schema no longer defines, so the
 * stale index would otherwise linger (and keep causing that collision) forever. `syncIndexes()`
 * reconciles the collection's actual indexes to exactly what's declared above — dropping the
 * stale one and creating the new one — and is a no-op once that's already happened.
 */
export async function syncChatChannelNameIndexes(): Promise<void> {
  await ChatChannelName.syncIndexes();
}

/** Lowercases + collapses whitespace so "Ardy  Splash" and "ardy splash" collide as the same name. */
export function normalizeChatChannelName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
