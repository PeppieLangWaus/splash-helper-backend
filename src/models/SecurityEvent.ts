import mongoose, { Document, Schema, Types } from 'mongoose';

export type SecurityEventType = 'setup-unknown-community' | 'setup-token-mismatch' | 'admin-generated-reset-link';

/** Audit trail for security-sensitive actions worth a human review trail: suspicious
 *  `/community-bot/verify-setup` attempts, and now admin-initiated password-reset links (see
 *  routes/admin.ts). Deliberately never stores a raw secret/token. Discord-bot fields
 *  (guildId/discordUserId/attemptedName) are optional since the admin-reset event type doesn't
 *  have a Discord guild/user context — it has an admin + a target username instead. */
export interface ISecurityEvent extends Document {
  type: SecurityEventType;
  communityId?: Types.ObjectId;
  guildId?: string;
  discordUserId?: string;
  attemptedName?: string;
  /** Set only for type: 'admin-generated-reset-link' — the admin who triggered it. */
  adminUsername?: string;
  /** Set only for type: 'admin-generated-reset-link' — the account the link was sent for. */
  targetUsername?: string;
  createdAt: Date;
}

const SecurityEventSchema = new Schema<ISecurityEvent>(
  {
    type: { type: String, enum: ['setup-unknown-community', 'setup-token-mismatch', 'admin-generated-reset-link'], required: true },
    communityId: { type: Schema.Types.ObjectId, ref: 'Community' },
    guildId: { type: String },
    discordUserId: { type: String },
    attemptedName: { type: String },
    adminUsername: { type: String },
    targetUsername: { type: String },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

export const SecurityEvent = mongoose.model<ISecurityEvent>('SecurityEvent', SecurityEventSchema);
