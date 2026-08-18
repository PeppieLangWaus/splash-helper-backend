import mongoose, { Document, Schema, Types } from 'mongoose';

/** A single-use password-reset credential — see utils/secureToken.ts. Only `tokenHash` is ever
 *  stored; the raw value lives solely in the one-time link emailed to the user. Deleted on
 *  successful use (routes/auth.ts's POST /reset-password/:token), and self-expires via the TTL
 *  index below as a backstop if it's never used at all. */
export interface IPasswordResetToken extends Document {
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  /** Audit metadata only — an admin-generated link (see routes/admin.ts's
   *  POST /users/:username/send-reset-link) behaves identically to a self-requested one. */
  requestedByAdmin: boolean;
  createdAt: Date;
}

const PasswordResetTokenSchema = new Schema<IPasswordResetToken>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    requestedByAdmin: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

// expireAfterSeconds: 0 means "expire at the exact time in this Date field", not "immediately".
PasswordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordResetToken = mongoose.model<IPasswordResetToken>('PasswordResetToken', PasswordResetTokenSchema);
