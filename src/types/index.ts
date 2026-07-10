import { WebSocket } from 'ws';

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
  | 'ACK';

export interface WsAuthMessage {
  type: 'AUTH';
  username: string;
  token: string;
}

export interface WsSessionMessage {
  type: 'SESSION_START' | 'SESSION_UPDATE' | 'SESSION_END';
  sessionData: SessionData;
}

export type WsIncomingMessage = WsAuthMessage | WsSessionMessage;

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

export type WsOutgoingMessage = WsAuthSuccessResponse | WsAuthFailureResponse | WsAckResponse;

// ── Active session state (in-memory) ────────────────────────────────────────

export interface ActiveSessionState {
  ws: WebSocket;
  username: string;
  sessionData: SessionData | null;
  authenticated: boolean;
  lastUpdate: number;
}

// ── JWT payload ──────────────────────────────────────────────────────────────

export interface JwtPayload {
  sub: string;   // username
  isAdmin: boolean;
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
    }
  }
}
