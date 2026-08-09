import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { ChatChannelType } from '../models/ChatChannelName';
import { RankInfo } from '../services/rankIcons';
import { ChatBroadcastMessage, WsChatMessageResponse, WsChatSubscribedResponse } from '../types';

const MAX_BUFFERED_MESSAGES = 100;

function bufferKey(communityId: string, channelType: ChatChannelType): string {
  return `${communityId}:${channelType}`;
}

// Ephemeral only, by design — nothing here survives a restart. See services/chatRelay.ts.
const recentMessages = new Map<string, ChatBroadcastMessage[]>();

// One subscription per socket: a frontend viewer watches a single community+channel at a time,
// and re-subscribing (switching tabs) simply replaces it.
const subscriptions = new Map<WebSocket, { communityId: string; channelType: ChatChannelType }>();

function send(ws: WebSocket, msg: WsChatSubscribedResponse | WsChatMessageResponse): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
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
 *  `rank` is optional so existing (pre-rank) callers keep working unchanged. */
export function broadcastChatMessage(
  communityId: string,
  channelType: ChatChannelType,
  sender: string | undefined,
  message: string,
  rank?: RankInfo,
): void {
  const payload: ChatBroadcastMessage = {
    id: randomUUID(),
    communityId,
    channelType,
    sender,
    message,
    timestamp: Date.now(),
    ...(rank ? { rank: rank.rank, rankName: rank.name, rankIconUrl: rank.iconUrl } : {}),
  };

  const key = bufferKey(communityId, channelType);
  const buffered = recentMessages.get(key) ?? [];
  buffered.push(payload);
  if (buffered.length > MAX_BUFFERED_MESSAGES) buffered.shift();
  recentMessages.set(key, buffered);

  for (const [ws, sub] of subscriptions) {
    if (sub.communityId === communityId && sub.channelType === channelType) {
      send(ws, { type: 'CHAT_MESSAGE', ...payload });
    }
  }
}
