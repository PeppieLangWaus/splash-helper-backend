import mongoose, { Document, Schema, Types } from 'mongoose';

/** A single-use email-verification credential — see utils/secureToken.ts. Same shape and
 *  lifecycle as PasswordResetToken, kept as a separate collection since the two have different
 *  expiries (24h vs 30min) and are never valid for each other's purpose. */
export interface IEmailVerificationToken extends Document {
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const EmailVerificationTokenSchema = new Schema<IEmailVerificationToken>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

EmailVerificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailVerificationToken = mongoose.model<IEmailVerificationToken>('EmailVerificationToken', EmailVerificationTokenSchema);
