import { WebSocket } from 'ws';
import { ActiveSessionState, SessionData } from '../types';

const sessions = new Map<string, ActiveSessionState>();

export function get(username: string): ActiveSessionState | undefined {
  return sessions.get(username);
}

export function getAll(): ActiveSessionState[] {
  return Array.from(sessions.values());
}

export function set(username: string, state: ActiveSessionState): void {
  sessions.set(username, state);
}

export function updateSessionData(username: string, sessionData: SessionData): void {
  const existing = sessions.get(username);
  if (existing) {
    existing.sessionData = sessionData;
    existing.lastUpdate = Date.now();
  }
}

export function remove(username: string): void {
  sessions.delete(username);
}

export function createInitialState(username: string, ws: WebSocket): ActiveSessionState {
  return {
    ws,
    username,
    sessionData: null,
    authenticated: false,
    lastUpdate: Date.now(),
  };
}

/** Removes all sessions whose WebSocket matches the given instance. */
export function removeBySocket(ws: WebSocket): string | undefined {
  for (const [username, state] of sessions.entries()) {
    if (state.ws === ws) {
      sessions.delete(username);
      return username;
    }
  }
  return undefined;
}
