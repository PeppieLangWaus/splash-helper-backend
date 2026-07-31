import mongoose, { Document, Schema, Types } from 'mongoose';

export type BankTicketType = 'deposit' | 'withdraw' | 'payout';
export type BankTicketStatus = 'pending' | 'completed' | 'rejected';

/** One deposit, withdrawal, or payout against a community's bank (Community.bankGp), raised by
 *  the Discord bot's /bank and /income commands. `amountGp` is frozen at creation time (for a
 *  payout, that's the splasher's available balance at the moment they requested it) and never
 *  recomputed, even if resolution happens later. */
export interface IBankTicket extends Document {
  communityId: Types.ObjectId;
  type: BankTicketType;
  amountGp: number;
  status: BankTicketStatus;
  /** For a payout, the splasher being paid; for a deposit/withdraw, the staff member who ran
   *  the command. requestedByUserId is only set when that Discord user resolves to a linked
   *  backend User (always true for payout, not guaranteed for deposit/withdraw staff). */
  requestedByUserId?: Types.ObjectId;
  requestedByUsername: string;
  requestedByDiscordId: string;
  /** The staff member who completed/rejected this ticket — for a payout this is whoever clicked
   *  Accept/Reject; for a deposit/withdraw this is the same person as requestedBy*, since running
   *  the command already required the bank-manager role. */
  authorizedByUsername?: string;
  authorizedByDiscordId?: string;
  screenshotUrl?: string;
  createdAt: Date;
  resolvedAt?: Date;
}

const BankTicketSchema = new Schema<IBankTicket>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: 'Community', required: true },
    type: { type: String, enum: ['deposit', 'withdraw', 'payout'], required: true },
    amountGp: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['pending', 'completed', 'rejected'], default: 'pending' },
    requestedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    requestedByUsername: { type: String, required: true },
    requestedByDiscordId: { type: String, required: true },
    authorizedByUsername: { type: String },
    authorizedByDiscordId: { type: String },
    screenshotUrl: { type: String },
    resolvedAt: { type: Date },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

BankTicketSchema.index({ communityId: 1, status: 1 });

export const BankTicket = mongoose.model<IBankTicket>('BankTicket', BankTicketSchema);
