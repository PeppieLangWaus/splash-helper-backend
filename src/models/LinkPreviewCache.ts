import mongoose, { Document, Schema } from 'mongoose';

/**
 * Cached result of resolving one external link (OSRS Wiki article, Discord invite, RuneLite
 * Plugin Hub listing, ...) to
 * preview data for the frontend's Discord-style hover tooltips (services/linkPreview.ts,
 * routes/linkPreview.ts). One document per `{ sourceType, key }` pair, self-expiring via the TTL
 * index below rather than ever being deleted explicitly — same pattern as
 * PasswordResetToken/EmailVerificationToken's `expiresAt` + `expireAfterSeconds: 0`.
 *
 * Negative results (page doesn't exist, invite invalid/revoked) are cached too, with `found:
 * false` and no `data` — this stops a broken/typo'd link from re-hitting the upstream API on
 * every hover, while still self-healing quickly since negative entries get a much shorter TTL
 * (see NEGATIVE_TTL_MS in linkPreview.ts) than real ones.
 */
export type LinkPreviewSourceType = 'wiki' | 'discord-invite' | 'plugin-hub';

export interface WikiPreviewData {
  title: string;
  extract?: string;
  thumbnailUrl?: string;
  canonicalUrl: string;
}

export interface DiscordInvitePreviewData {
  guildName: string;
  guildIconUrl?: string;
  description?: string;
  memberCount?: number;
  onlineCount?: number;
  channelName?: string;
}

export interface PluginHubPreviewData {
  displayName: string;
  author: string;
  description?: string;
  iconUrl?: string;
  stars?: number;
  repoUrl: string;
}

export type LinkPreviewData = WikiPreviewData | DiscordInvitePreviewData | PluginHubPreviewData;

export interface ILinkPreviewCache extends Document {
  sourceType: LinkPreviewSourceType;
  /** Normalized lookup key within `sourceType` — the wiki's canonical page title (post-redirect),
   *  or the Discord invite code. Never the raw URL, so e.g. `/w/Rune_scimitar` and a link with a
   *  trailing `#Section` anchor share one cache entry. */
  key: string;
  found: boolean;
  data?: LinkPreviewData;
  expiresAt: Date;
  createdAt: Date;
}

const LinkPreviewCacheSchema = new Schema<ILinkPreviewCache>(
  {
    sourceType: { type: String, required: true, enum: ['wiki', 'discord-invite', 'plugin-hub'] },
    key: { type: String, required: true },
    found: { type: Boolean, required: true },
    data: { type: Schema.Types.Mixed },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

LinkPreviewCacheSchema.index({ sourceType: 1, key: 1 }, { unique: true });
// expireAfterSeconds: 0 means "expire at the exact time in this Date field", not "immediately" —
// see PasswordResetToken.ts for the same pattern.
LinkPreviewCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LinkPreviewCache = mongoose.model<ILinkPreviewCache>('LinkPreviewCache', LinkPreviewCacheSchema);
