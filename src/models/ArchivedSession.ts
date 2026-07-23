import mongoose, { Document, Schema, Types } from 'mongoose';
import { SessionData } from '../types';

export interface IArchivedSession extends Document {
  sessionId: string;
  createdTimestamp: number;
  finalizedTimestamp: number;
  userId: Types.ObjectId;
  username: string;
  session: SessionData;
  /** Discord message id of the archived-session notification, so a resumed session that
   *  finalizes again can edit the existing post in place instead of adding a new one. */
  discordMessageId?: string;
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
    discordMessageId: { type: String },
  },
  { timestamps: false },
);

// One archived record per (user, session start): a session that is finalized, resumed,
// and finalized again shares the same createdTimestamp (startTime) across those finalizations,
// and should update the existing row rather than create a sibling one.
ArchivedSessionSchema.index(
  { userId: 1, createdTimestamp: 1 },
  { unique: true },
);

export const ArchivedSession = mongoose.model<IArchivedSession>(
  'ArchivedSession',
  ArchivedSessionSchema,
);
