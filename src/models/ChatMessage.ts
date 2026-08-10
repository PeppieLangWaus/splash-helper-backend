import mongoose, { Document, Schema, Types } from 'mongoose';
import { ChatChannelType } from './ChatChannelName';

/**
 * A relayed Friends Chat / Clan Chat line, persisted so a community's chat history survives a
 * server restart and can be loaded by the frontend on page load (before/without a live
 * WebSocket subscription) — see websocket/chatBroadcast.ts, whose own ring buffer is deliberately
 * ephemeral and only ever backs the live feed. Written by services/chatHistory.ts, which also
 * caps how many of these accumulate per (community, channelType) pair so this collection doesn't
 * grow without bound.
 */
export interface IChatMessage extends Document {
  communityId: Types.ObjectId;
  channelType: ChatChannelType;
  sender?: string;
  message: string;
  /** Unix epoch *milliseconds* — matches ChatBroadcastMessage.timestamp, not a Mongo Date. */
  timestamp: number;
  /** Same optional rank badge fields as ChatBroadcastMessage — see services/rankIcons.ts. */
  rank?: number;
  rankName?: string;
  rankIconUrl?: string;
  createdAt: Date;
}

const ChatMessageSchema = new Schema<IChatMessage>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: 'Community', required: true },
    channelType: { type: String, enum: ['fc', 'cc'], required: true },
    sender: { type: String },
    message: { type: String, required: true },
    timestamp: { type: Number, required: true },
    rank: { type: Number },
    rankName: { type: String },
    rankIconUrl: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Backs both the history load (sorted newest-first, limited) and the prune sweep (oldest-first)
// in services/chatHistory.ts.
ChatMessageSchema.index({ communityId: 1, channelType: 1, timestamp: -1 });

export const ChatMessage = mongoose.model<IChatMessage>('ChatMessage', ChatMessageSchema);
