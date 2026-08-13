import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { ChatChannelType } from '../models/ChatChannelName';
import { RankInfo } from '../services/rankIcons';
import {
  ChatBroadcastMessage,
  WsChatMessageEditedResponse,
  WsChatMessageResponse,
  WsChatSubscribedResponse,
} from '../types';

const MAX_BUFFERED_MESSAGES = 100;

function bufferKey(communityId: string, channelType: ChatChannelType): string {
  return `${communityId}:${channelType}`;
}

// Ephemeral only, by design — nothing here survives a restart. See services/chatRelay.ts.
const recentMessages = new Map<string, ChatBroadcastMessage[]>();

// One subscription per socket: a frontend viewer watches a single community+channel at a time,
// and re-subscribing (switching tabs) simply replaces it.
const subscriptions = new Map<WebSocket, { communityId: string; channelType: ChatChannelType }>();

function send(
  ws: WebSocket,
  msg: WsChatSubscribedResponse | WsChatMessageResponse | WsChatMessageEditedResponse,
): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/** The plugin's own (id, timestamp, type) for a relayed line — see services/chatRelay.ts's
 *  RawChatRelayMessage. Used only to correlate an `edited: true` resend with the message it
 *  updates; `id` alone is not globally unique (a small per-session counter from the game client),
 *  so a match always requires all three together. */
export interface ChatMessageSource {
  id: number;
  timestamp: number;
  type: string;
  edited: boolean;
}

/** Finds the most recently buffered message (for this community+channel) with the same source
 *  (id, timestamp, type), searching newest-first since an edited resend follows its original
 *  within ~8s and so is almost always near the end of the buffer. */
function findBufferedIndex(buffered: ChatBroadcastMessage[], source: Pick<ChatMessageSource, 'id' | 'timestamp' | 'type'>): number {
  for (let i = buffered.length - 1; i >= 0; i--) {
    const existing = buffered[i];
    if (existing.sourceId === source.id && existing.sourceTimestamp === source.timestamp && existing.sourceType === source.type) {
      return i;
    }
  }
  return -1;
}

/** Subscribes a socket to one community's FC or CC feed, replacing any prior subscription, and
 *  immediately sends back whatever's buffered so the viewer isn't staring at a blank window. */
export function subscribeChat(ws: WebSocket, communityId: string, channelType: ChatChannelType): void {
  subscriptions.set(ws, { communityId, channelType });
  const recent = recentMessages.get(bufferKey(communityId, channelType)) ?? [];
  send(ws, { type: 'CHAT_SUBSCRIBED', communityId, channelType, recent });
}

export function unsubscribeChat(ws: WebSocket): void {
  subscriptions.delete(ws);
}

/** Buffers a message for late joiners and pushes it to every socket currently watching this
 *  community+channel. Called by chatRelay.ts once a relayed message has been classified and
 *  allowed through — independent of whether that community has a Discord webhook configured.
 *  `rank` is optional so existing (pre-rank) callers keep working unchanged.
 *
 *  When `source.edited` is true, this is a follow-up resend of a message already broadcast once
 *  (same source id/timestamp/type) with `message` updated to a since-resolved chat command's
 *  output — the matching buffered entry is updated in place and re-sent as CHAT_MESSAGE_EDITED
 *  rather than appended as a new line. If no match is found (the original never arrived, or this
 *  service restarted in between), it's inserted as a normal new message instead. */
export function broadcastChatMessage(
  communityId: string,
  channelType: ChatChannelType,
  sender: string | undefined,
  message: string,
  rank?: RankInfo,
  source?: ChatMessageSource,
): void {
  const key = bufferKey(communityId, channelType);
  const buffered = recentMessages.get(key) ?? [];

  if (source?.edited) {
    const index = findBufferedIndex(buffered, source);
    if (index !== -1) {
      const updated: ChatBroadcastMessage = { ...buffered[index], message, edited: true };
      buffered[index] = updated;
      recentMessages.set(key, buffered);

      for (const [ws, sub] of subscriptions) {
        if (sub.communityId === communityId && sub.channelType === channelType) {
          send(ws, { type: 'CHAT_MESSAGE_EDITED', ...updated });
        }
      }
      return;
    }
    // Fall through and insert below — same handling as a message that was never marked edited.
  }

  const payload: ChatBroadcastMessage = {
    id: randomUUID(),
    communityId,
    channelType,
    sender,
    message,
    timestamp: Date.now(),
    ...(rank ? { rank: rank.rank, rankName: rank.name, rankIconUrl: rank.iconUrl } : {}),
    ...(source ? { sourceId: source.id, sourceTimestamp: source.timestamp, sourceType: source.type, edited: source.edited } : {}),
  };

  buffered.push(payload);
  if (buffered.length > MAX_BUFFERED_MESSAGES) buffered.shift();
  recentMessages.set(key, buffered);

  for (const [ws, sub] of subscriptions) {
    if (sub.communityId === communityId && sub.channelType === channelType) {
      send(ws, { type: 'CHAT_MESSAGE', ...payload });
    }
  }
}
