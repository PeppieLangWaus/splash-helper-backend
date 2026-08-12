import mongoose, { Document, Schema } from 'mongoose';

export type VoteValue = 1 | -1;

/** One anonymous like (1) or dislike (-1) cast on a splasher. Voting is public — no account
 *  required — so a voter is identified by `voterHash` (see utils/voterHash.ts) rather than a
 *  user id. The unique index below is what actually enforces "one vote per voter per splasher":
 *  routes/splashers.ts upserts against it, so re-voting updates or removes this document
 *  instead of ever inserting a second one. */
export interface ISplasherVote extends Document {
  splasherUsername: string;
  voterHash: string;
  value: VoteValue;
  createdAt: Date;
  updatedAt: Date;
}

const SplasherVoteSchema = new Schema<ISplasherVote>(
  {
    splasherUsername: { type: String, required: true, trim: true },
    voterHash: { type: String, required: true },
    value: { type: Number, enum: [1, -1], required: true },
  },
  { timestamps: true },
);

SplasherVoteSchema.index({ splasherUsername: 1, voterHash: 1 }, { unique: true });

export const SplasherVote = mongoose.model<ISplasherVote>('SplasherVote', SplasherVoteSchema);
