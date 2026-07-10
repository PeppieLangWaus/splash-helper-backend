import mongoose, { Document, Schema, Types } from 'mongoose';
import { SessionData } from '../types';

export interface IArchivedSession extends Document {
  sessionId: string;
  createdTimestamp: number;
  finalizedTimestamp: number;
  userId: Types.ObjectId;
  username: string;
  session: SessionData;
}

const SessionDataSchema = new Schema<SessionData>(
  {
    playerName: { type: String, required: true },
    spell: { type: String, required: true },
    runeCostPerCast: { type: Number, required: true },
    startTime: { type: String, required: true },
    logoutTime: { type: String, required: true },
    world: { type: Number, required: true },
    stickyKnight: { type: Boolean, required: true },
    spellsCast: { type: Number, required: true },
    startMagicXp: { type: Number, required: true },
    currentMagicXp: { type: Number, required: true },
    knightMovements: { type: Number, required: true },
    endTime: { type: String },
    highestPlayerCount: { type: Number, required: true },
    averagePlayerCount: { type: Number, required: true },
    pickpocketerCount: { type: Number, required: true },
    startingRuneCount: { type: Number, required: true },
    currentRuneCount: { type: Number, required: true },
    runeUsageMap: { type: Map, of: Number, required: true },
    runeCostGp: { type: Number, required: true },
  },
  { _id: false },
);

const ArchivedSessionSchema = new Schema<IArchivedSession>(
  {
    sessionId: { type: String, required: true },
    createdTimestamp: { type: Number, required: true },
    finalizedTimestamp: { type: Number, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    session: { type: SessionDataSchema, required: true },
  },
  { timestamps: false },
);

// Compound index to prevent duplicate sessions per user
ArchivedSessionSchema.index(
  { userId: 1, createdTimestamp: 1, finalizedTimestamp: 1 },
  { unique: true },
);

export const ArchivedSession = mongoose.model<IArchivedSession>(
  'ArchivedSession',
  ArchivedSessionSchema,
);
