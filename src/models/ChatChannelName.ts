import mongoose, { Document, Schema, Types } from 'mongoose';

export type ChatChannelType = 'fc' | 'cc';

/**
 * Maps an in-game Friends Chat / Clan Chat to the community that owns it, so the global
 * chat-relay endpoint (chat.splasher.help / chat.ardy.host — see routes/chatRelay.ts) can figure
 * out which community a message belongs to from its content alone, with no per-community URL or
 * token involved. One document per (community, channelType) pair — a community has at most one
 * FC registration and one CC registration at a time.
 *
 * Clan Chat is trusted by **name**: `normalizedName` is what lookups and the uniqueness
 * constraint use (case-insensitive, trimmed), `name` keeps the owner's original casing for
 * display. Friends Chat is trusted by **owner** instead (`ownerName`/`normalizedOwnerName`) —
 * unlike a Jagex clan, an FC's in-game name is just whatever its owner currently has it set to
 * and can be changed at any time, so a name registered once would silently go stale the next time
 * the owner renamed it. `name`/`normalizedName` are still kept on the FC doc for display (chat-
 * config, the chatbox picker, the Discord relay line prefix), but chatRelay.ts's
 * `syncFriendsChatIdentity` keeps them self-healing from live traffic rather than trusting them
 * for classification. A freshly-registered FC (owner set, no message relayed yet) has no
 * `name`/`normalizedName` at all until its first message arrives.
 */
export interface IChatChannelName extends Document {
  communityId: Types.ObjectId;
  channelType: ChatChannelType;
  name?: string;
  normalizedName?: string;
  /** Friends-Chat-only trust anchor — the FC owner's RSN. Unset for a 'cc' doc, and unset for an
   *  'fc' doc registered before this field existed until chatRelay.ts's `syncFriendsChatIdentity`
   *  opportunistically captures it off the first relayed message that still matches by name. */
  ownerName?: string;
  normalizedOwnerName?: string;
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
    name: { type: String, trim: true },
    normalizedName: { type: String },
    ownerName: { type: String, trim: true },
    normalizedOwnerName: { type: String },
    displayName: { type: String, trim: true },
  },
  { timestamps: true },
);

// A (name, channelType) pair can only ever point at one community — the entire trust mechanism
// Clan Chat classification relies on (Friends Chat uses the ownerName index below instead — see
// the interface doc comment for why). Scoped to docs that don't yet have an `ownerName`: once an
// FC doc is captured onto owner-based trust, its `name` is free to drift (self-healed from live
// traffic) without fighting this constraint or colliding with another community's currently-live
// FC name. Deliberately *not* unique on normalizedName alone: Friends Chats and Clan Chats are
// separate in-game namespaces, so an FC and a CC legitimately can share a name (even across two
// different communities) without colliding.
ChatChannelNameSchema.index(
  { normalizedName: 1, channelType: 1 },
  { unique: true, partialFilterExpression: { normalizedName: { $exists: true }, ownerName: { $exists: false } } },
);
// The Friends Chat trust anchor once captured (see interface doc comment) — a given owner RSN can
// only ever point at one community's FC registration.
ChatChannelNameSchema.index(
  { normalizedOwnerName: 1 },
  { unique: true, partialFilterExpression: { normalizedOwnerName: { $exists: true } } },
);
// One FC and one CC registration per community; re-registering the same type replaces it.
ChatChannelNameSchema.index({ communityId: 1, channelType: 1 }, { unique: true });

export const ChatChannelName = mongoose.model<IChatChannelName>('ChatChannelName', ChatChannelNameSchema);

/**
 * One-time startup migration: reconciles the collection's actual indexes to exactly what's
 * declared above. Originally replaced the old `{ normalizedName: 1 }` unique index (which made an
 * FC and a CC collide whenever they shared a name) with `{ normalizedName: 1, channelType: 1 }`;
 * now also replaces *that* with the partial version above (scoped to docs without an `ownerName`)
 * plus the new `normalizedOwnerName` index, so existing FC docs aren't stuck unable to ever gain
 * an `ownerName` alongside a still-unique `name`. Mongoose's default autoIndex only *adds* indexes
 * newly declared in the schema; it never drops or redefines ones the schema no longer matches
 * exactly, so a stale index would otherwise linger forever. `syncIndexes()` is a no-op once this
 * has already run.
 */
export async function syncChatChannelNameIndexes(): Promise<void> {
  await ChatChannelName.syncIndexes();
}

/** Lowercases + collapses whitespace so "Ardy  Splash" and "ardy splash" collide as the same name. */
export function normalizeChatChannelName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
