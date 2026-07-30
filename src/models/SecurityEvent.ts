import mongoose, { Document, Schema, Types } from 'mongoose';

export type SecurityEventType = 'setup-unknown-community' | 'setup-token-mismatch';

/** Audit trail for suspicious `/community-bot/verify-setup` attempts, so an admin can review
 *  who tried to pair a Discord server with a community they don't hold a valid token for.
 *  Deliberately never stores the raw token that was attempted. */
export interface ISecurityEvent extends Document {
  type: SecurityEventType;
  communityId?: Types.ObjectId;
  guildId: string;
  discordUserId: string;
  attemptedName: string;
  createdAt: Date;
}

const SecurityEventSchema = new Schema<ISecurityEvent>(
  {
    type: { type: String, enum: ['setup-unknown-community', 'setup-token-mismatch'], required: true },
    communityId: { type: Schema.Types.ObjectId, ref: 'Community' },
    guildId: { type: String, required: true },
    discordUserId: { type: String, required: true },
    attemptedName: { type: String, required: true },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

export const SecurityEvent = mongoose.model<ISecurityEvent>('SecurityEvent', SecurityEventSchema);
