import mongoose, { Document, Schema, Types } from 'mongoose';
import { randomBytes } from 'crypto';

export interface ICommunity extends Document {
  name: string;
  ownerIds: Types.ObjectId[];
  memberUserIds: Types.ObjectId[];
  /** Discord webhooks the owner supplied for posting this community's splashers' data.
   *  Unset/empty disables posting for that stream; the two are independent. */
  discordActiveWebhookUrl?: string;
  discordHistoryWebhookUrl?: string;
  /** Public invite link for this community's Discord server. Shown alongside a splasher's
   *  identity on the public active-sessions feed, and owner-configurable like the webhooks. */
  discordInviteUrl?: string;
  /** Bearer credential for the `/api/community-bot/*` routes and any other external
   *  community-scoped API access. Stored in plaintext, same convention as `User.token` —
   *  it's shown back to the owner (Account Settings) rather than a show-once secret. */
  apiToken: string;
  /** The community's GP treasury, adjusted by staff `/bank deposit`/`/bank withdraw` and by
   *  completed `/income payout` requests (see BankTicket). Never goes negative. */
  bankGp: number;
  createdAt: Date;
}

const CommunitySchema = new Schema<ICommunity>(
  {
    name: { type: String, required: true, trim: true },
    ownerIds: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
    memberUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    discordActiveWebhookUrl: { type: String },
    discordHistoryWebhookUrl: { type: String },
    discordInviteUrl: { type: String },
    apiToken: {
      type: String,
      required: true,
      unique: true,
      default: () => randomBytes(32).toString('hex'),
    },
    bankGp: { type: Number, default: 0, min: 0 },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

CommunitySchema.index({ ownerIds: 1 });
CommunitySchema.index({ memberUserIds: 1 });

export const Community = mongoose.model<ICommunity>('Community', CommunitySchema);
