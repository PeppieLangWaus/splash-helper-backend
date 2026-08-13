import { WebSocket } from 'ws';
import type { ICommunity } from '../models/Community';
import type { ChatChannelType } from '../models/ChatChannelName';

export interface RuneUsageMap {
  [runeId: string]: number;
}

export interface SessionData {
  playerName: string;
  spell: string;
  runeCostPerCast: number;
  startTime: string;
  logoutTime: string;
  world: number;
  stickyKnight: boolean;
  spellsCast: number;
  startMagicXp: number;
  currentMagicXp: number;
  knightMovements: number;
  endTime?: string;
  highestPlayerCount: number;
  averagePlayerCount: number;
  /** Live nearby-player count at the moment of this update (as opposed to highest/average). */
  currentPlayerCount?: number;
  pickpocketerCount: number;
  startingRuneCount: number;
  currentRuneCount: number;
  runeUsageMap: RuneUsageMap;
  runeCostGp: number;
}

export interface SplashEntry {
  sessionId: string;
  createdTimestamp: number;
  finalizedTimestamp: number;
  syncedToServer: boolean;
  session: SessionData;
}

export interface Splasher {
  username: string;
  sessions: SplashEntry[];
}

/** @deprecated Remove after full lowdb migration */
export interface Database {
  splashers: Splasher[];
}

// ── WebSocket protocol ──────────────────────────────────────────────────────

export type WsMessageType =
  | 'AUTH'
  | 'SESSION_START'
  | 'SESSION_UPDATE'
  | 'SESSION_END'
  | 'AUTH_SUCCESS'
  | 'AUTH_FAILURE'
  | 'ACK'
  | 'SUBSCRIBE_CHAT'
  | 'UNSUBSCRIBE_CHAT'
  | 'CHAT_SUBSCRIBED'
  | 'CHAT_MESSAGE';

export interface WsAuthMessage {
  type: 'AUTH';
  username: string;
  token: string;
}

export interface WsSessionMessage {
  type: 'SESSION_START' | 'SESSION_UPDATE' | 'SESSION_END';
  sessionData: SessionData;
}

/**
 * Sent by a frontend viewer (not the RuneLite plugin) to watch one community's Friends Chat or
 * Clan Chat feed — see websocket/chatBroadcast.ts. Deliberately requires no AUTH: it's a
 * read-only subscription, not a splash session. Subscribing again replaces any previous
 * subscription on the same socket (a viewer only watches one channel at a time).
 */
export interface WsSubscribeChatMessage {
  type: 'SUBSCRIBE_CHAT';
  communityId: string;
  channelType: ChatChannelType;
}

export interface WsUnsubscribeChatMessage {
  type: 'UNSUBSCRIBE_CHAT';
}

export type WsIncomingMessage = WsAuthMessage | WsSessionMessage | WsSubscribeChatMessage | WsUnsubscribeChatMessage;

export interface WsAuthSuccessResponse {
  type: 'AUTH_SUCCESS';
  setupRequired: boolean;
  setupLink?: string;
}

export interface WsAuthFailureResponse {
  type: 'AUTH_FAILURE';
  reason: string;
}

export interface WsAckResponse {
  type: 'ACK';
}

/** A real OSRS item id + quantity, resolved server-side via services/itemLogResolver.ts — never
 *  derived from a client-local `<img=N>` chat tag (a per-viewer-session sprite index with no
 *  relation to the real item id). `quantity` is always 1 for a pet (never stackable). */
export interface ChatItemRef {
  id: number;
  quantity: number;
}

/** One chat-relay message, broadcast to every socket subscribed to this community+channel. */
export interface ChatBroadcastMessage {
  id: string;
  communityId: string;
  channelType: ChatChannelType;
  sender?: string;
  message: string;
  timestamp: number;
  /** The sender's FC/CC rank, resolved to a display name + icon via services/rankIcons.ts (see
   *  RuneLite's FriendsChatRank/ClanRank). Omitted when the payload's rank has no fixed identity
   *  we can resolve server-side (unranked FC, or one of a clan's own custom-titled ranks). */
  rank?: number;
  rankName?: string;
  rankIconUrl?: string;
  /** Present when `message` is a `!log <page>`/`!log missing <page>`/`!pets` command — the real
   *  items that command's output actually describes, resolved server-side via
   *  services/itemLogResolver.ts. `message` itself stays the literal typed command text; this is
   *  additive enrichment, not a replacement, so a viewer that doesn't understand it can still
   *  show the plain line. Absent for every other message, and for one of these commands if
   *  resolution failed (unlinked account, unknown page, upstream API error/timeout). */
  items?: ChatItemRef[];
  /** The plugin's own (id, timestamp, type) for this line — present whenever the relay could
   *  extract them, and used solely to correlate a later `edited: true` resend with this message
   *  (see websocket/chatBroadcast.ts). Not a stable/global identifier on its own: `sourceId`
   *  alone is a small per-session counter from the game client, not unique across senders. */
  sourceId?: number;
  sourceTimestamp?: number;
  sourceType?: string;
  /** True once this message has been updated in place by an edited resend of a chat command that
   *  resolved after it was first sent. */
  edited?: boolean;
}

/** Acks a SUBSCRIBE_CHAT and backfills recent history (see chatBroadcast's ring buffer) so the
 *  chatbox isn't blank while waiting for the next live message. */
export interface WsChatSubscribedResponse {
  type: 'CHAT_SUBSCRIBED';
  communityId: string;
  channelType: ChatChannelType;
  recent: ChatBroadcastMessage[];
}

export interface WsChatMessageResponse extends ChatBroadcastMessage {
  type: 'CHAT_MESSAGE';
}

/** Sent instead of a second WsChatMessageResponse when an edited resend (see ChatBroadcastMessage
 *  .edited) was correlated with a message already broadcast — same shape, so a viewer can update
 *  the matching `id` in place rather than appending a duplicate line. */
export interface WsChatMessageEditedResponse extends ChatBroadcastMessage {
  type: 'CHAT_MESSAGE_EDITED';
}

export type WsOutgoingMessage =
  | WsAuthSuccessResponse
  | WsAuthFailureResponse
  | WsAckResponse
  | WsChatSubscribedResponse
  | WsChatMessageResponse
  | WsChatMessageEditedResponse;

// ── Active session state (in-memory) ────────────────────────────────────────

export interface ActiveSessionState {
  ws: WebSocket;
  username: string;
  userId: string;
  sessionData: SessionData | null;
  authenticated: boolean;
  lastUpdate: number;
}

// ── JWT payload ──────────────────────────────────────────────────────────────

export interface JwtPayload {
  sub: string;   // username
  isAdmin: boolean;
  communityEligible: boolean;
  iat?: number;
  exp?: number;
}

export interface SetupLinkJwtPayload {
  purpose: 'account-setup';
  username: string;
  iat?: number;
  exp?: number;
}

// ── Express request augmentation ─────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      /** Set by `requireCommunityToken` — the Community whose `apiToken` matched the
       *  `X-Community-Token` header on this request. */
      community?: ICommunity;
    }
  }
}
