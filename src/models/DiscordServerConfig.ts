import mongoose, { Document, Schema, Types } from 'mongoose';

/** One Discord server's `/setup` configuration, one per Community. Owned entirely by the
 *  bot via the community-token-authenticated `/api/community-bot/discord-config` route. */
export interface IDiscordServerConfig extends Document {
  communityId: Types.ObjectId;
  guildId: string;
  supportRoleIds: string[];
  supportTicketChannelId?: string;
  splasherLinkChannelId?: string;
  historyChannelId?: string;
  activeWorldsChannelId?: string;
  autoAddSplashers: boolean;
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
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

export const DiscordServerConfig = mongoose.model<IDiscordServerConfig>(
  'DiscordServerConfig',
  DiscordServerConfigSchema,
);
