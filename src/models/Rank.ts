import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IRank extends Document {
  communityId: Types.ObjectId;
  name: string;
  hourlyRate: number;
  isDefault: boolean;
  createdAt: Date;
}

const RankSchema = new Schema<IRank>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: 'Community', required: true },
    name: { type: String, required: true, trim: true },
    hourlyRate: { type: Number, required: true, default: 0, min: 0 },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

RankSchema.index({ communityId: 1 });

export const Rank = mongoose.model<IRank>('Rank', RankSchema);
