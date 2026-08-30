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
  /** Mirrors "this doc has no `ownerName`" as a plain equality-friendly flag — `true` while a doc
   *  is still trusted by name, unset/`false` once `ownerName` is captured. Exists only because
   *  MongoDB's `partialFilterExpression` rejects `$exists: false` (it's implemented via `$not`,
   *  which partial indexes don't support — see the `normalizedName_1_channelType_1` index below);
   *  `{ nameTrustEligible: true }` is a plain equality clause it does accept, and is kept in sync
   *  everywhere `ownerName` gets set. Never read directly outside that index — `ownerName`
   *  presence/absence remains the actual source of truth. */
  nameTrustEligible?: boolean;
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
    nameTrustEligible: { type: Boolean },
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
// Filters on `nameTrustEligible: true` rather than `ownerName: { $exists: false }` — see that
// field's doc comment on the interface above for why the direct `$exists: false` form isn't legal
// here.
ChatChannelNameSchema.index(
  { normalizedName: 1, channelType: 1 },
  { unique: true, partialFilterExpression: { normalizedName: { $exists: true }, nameTrustEligible: true } },
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
 *
 * Backfills `nameTrustEligible` first: any doc written before that field existed has a
 * `normalizedName` but no `ownerName` and no `nameTrustEligible` yet, so without this the partial
 * index above would silently exclude it (equality against `true` doesn't match a missing field)
 * until its next unrelated write — leaving it able to collide with another community's name in
 * the meantime.
 */
export async function syncChatChannelNameIndexes(): Promise<void> {
  await ChatChannelName.updateMany(
    { normalizedName: { $exists: true }, ownerName: { $exists: false }, nameTrustEligible: { $ne: true } },
    { $set: { nameTrustEligible: true } },
  );
  await ChatChannelName.syncIndexes();
}

/** Lowercases + collapses whitespace so "Ardy  Splash" and "ardy splash" collide as the same name. */
export function normalizeChatChannelName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
