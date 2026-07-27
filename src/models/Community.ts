import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ICommunity extends Document {
  name: string;
  ownerIds: Types.ObjectId[];
  memberUserIds: Types.ObjectId[];
  /** Discord webhooks the owner supplied for posting this community's splashers' data.
   *  Unset/empty disables posting for that stream; the two are independent. */
  discordActiveWebhookUrl?: string;
  discordHistoryWebhookUrl?: string;
  createdAt: Date;
}

const CommunitySchema = new Schema<ICommunity>(
  {
    name: { type: String, required: true, trim: true },
    ownerIds: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
    memberUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    discordActiveWebhookUrl: { type: String },
    discordHistoryWebhookUrl: { type: String },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

CommunitySchema.index({ ownerIds: 1 });
CommunitySchema.index({ memberUserIds: 1 });

export const Community = mongoose.model<ICommunity>('Community', CommunitySchema);
