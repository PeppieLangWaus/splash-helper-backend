import mongoose, { Document, Schema, Types } from 'mongoose';

export type ApplicationSource = 'website' | 'discord-link';
export type ApplicationStatus = 'pending' | 'approved' | 'rejected';

export interface ISplasherApplication extends Document {
  communityId: Types.ObjectId;
  userId: Types.ObjectId;
  source: ApplicationSource;
  status: ApplicationStatus;
  createdAt: Date;
  resolvedAt?: Date;
}

const SplasherApplicationSchema = new Schema<ISplasherApplication>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: 'Community', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    source: { type: String, enum: ['website', 'discord-link'], required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    resolvedAt: { type: Date },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

SplasherApplicationSchema.index({ communityId: 1, status: 1 });

export const SplasherApplication = mongoose.model<ISplasherApplication>(
  'SplasherApplication',
  SplasherApplicationSchema,
);
