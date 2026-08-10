import { ChatMessage } from '../models/ChatMessage';
import { ChatChannelType } from '../models/ChatChannelName';
import { ChatBroadcastMessage } from '../types';
import { logWarn } from '../utils/logger';

// Mirrors websocket/chatBroadcast.ts's own MAX_BUFFERED_MESSAGES ring buffer, just persisted —
// the chatbox only ever needs recent history, not a full permanent log, so there's no reason to
// let this collection grow without bound.
const MAX_STORED_MESSAGES_PER_CHANNEL = 200;

/** Default/ceiling for how many messages a single history load can request — see
 *  routes/chatChannels.ts. */
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = MAX_STORED_MESSAGES_PER_CHANNEL;

/** Deletes the oldest rows for one (community, channelType) pair once it's grown past the cap.
 *  A count-then-delete round trip per message is fine here — same "traffic is far too low to
 *  need anything more" reasoning as chatRelay.ts's dedup sweep. */
async function pruneOldMessages(communityId: string, channelType: ChatChannelType): Promise<void> {
  const count = await ChatMessage.countDocuments({ communityId, channelType });
  const excess = count - MAX_STORED_MESSAGES_PER_CHANNEL;
  if (excess <= 0) return;

  const oldest = await ChatMessage.find({ communityId, channelType }, { _id: 1 })
    .sort({ timestamp: 1 })
    .limit(excess)
    .lean();
  await ChatMessage.deleteMany({ _id: { $in: oldest.map((d) => d._id) } });
}

/**
 * Persists one already-broadcast chat message (see websocket/chatBroadcast.ts's
 * broadcastChatMessage, called alongside this from services/chatRelay.ts) and prunes this
 * channel's history back down to the cap if needed. Best-effort: a persistence failure shouldn't
 * take down the relay — the message has already gone out live via the websocket and to Discord
 * regardless of whether it makes it into history.
 */
export async function persistChatMessage(entry: ChatBroadcastMessage): Promise<void> {
  try {
    await ChatMessage.create({
      communityId: entry.communityId,
      channelType: entry.channelType,
      sender: entry.sender,
      message: entry.message,
      timestamp: entry.timestamp,
      rank: entry.rank,
      rankName: entry.rankName,
      rankIconUrl: entry.rankIconUrl,
    });
    await pruneOldMessages(entry.communityId, entry.channelType);
  } catch (err) {
    // Optional chaining here matters: `entry` itself may be malformed (or missing entirely) —
    // this log call must never be the thing that turns a bad payload into an unhandled rejection.
    logWarn(`Failed to persist chat message for community ${entry?.communityId}: ${(err as Error).message}`);
  }
}

/** Loads the most recent `limit` messages for one community+channel, oldest first — same
 *  ordering as the WebSocket's CHAT_SUBSCRIBED `recent` backfill, so the frontend can render
 *  either straight into the same list. For routes/chatChannels.ts's GET history endpoint. */
export async function getRecentChatMessages(
  communityId: string,
  channelType: ChatChannelType,
  limit: number,
): Promise<ChatBroadcastMessage[]> {
  const docs = await ChatMessage.find({ communityId, channelType })
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();

  return docs.reverse().map((d) => ({
    id: d._id.toString(),
    communityId: d.communityId.toString(),
    channelType: d.channelType,
    sender: d.sender,
    message: d.message,
    timestamp: d.timestamp,
    ...(d.rank !== undefined ? { rank: d.rank, rankName: d.rankName, rankIconUrl: d.rankIconUrl } : {}),
  }));
}
