import mongoose, { Document, Schema, Types } from 'mongoose';

/** One Discord server's `/setup` configuration, one per Community. Written by the bot via the
 *  community-token-authenticated `/api/community-bot/discord-config` route, and editable by the
 *  community owner via `/api/communities/:communityId/discord-config` on the website. */
export interface IDiscordServerConfig extends Document {
  communityId: Types.ObjectId;
  guildId: string;
  supportRoleIds: string[];
  supportTicketChannelId?: string;
  splasherLinkChannelId?: string;
  historyChannelId?: string;
  activeWorldsChannelId?: string;
  autoAddSplashers: boolean;
  /** Channel where /bank deposit, /bank withdraw, and completed /income payout requests are
   *  logged, one thread per transaction. */
  bankChannelId?: string;
  /** Roles allowed to run /bank deposit, /bank withdraw, and accept /income payout tickets —
   *  distinct from supportRoleIds, which only pings for general support tickets. */
  bankManagerRoleIds: string[];
  /** Minimum available (earned minus already paid out) GP a splasher needs before /income payout
   *  will open a ticket for them. */
  minPayoutGp: number;
  createdAt: Date;
}

const DiscordServerConfigSchema = new Schema<IDiscordServerConfig>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: 'Community', required: true, unique: true },
    guildId: { type: String, required: true },
    supportRoleIds: [{ type: String }],
    supportTicketChannelId: { type: String },
    splasherLinkChannelId: { type: String },
    historyChannelId: { type: String },
    activeWorldsChannelId: { type: String },
    autoAddSplashers: { type: Boolean, default: false },
    bankChannelId: { type: String },
    bankManagerRoleIds: [{ type: String }],
    minPayoutGp: { type: Number, default: 10_000_000, min: 0 },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

export const DiscordServerConfig = mongoose.model<IDiscordServerConfig>(
  'DiscordServerConfig',
  DiscordServerConfigSchema,
);
