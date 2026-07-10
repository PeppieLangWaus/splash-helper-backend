import { WebSocket } from 'ws';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { User } from '../models/User';
import { ArchivedSession } from '../models/ArchivedSession';
import { generateSetupLink } from '../routes/auth';
import {
  get as getSession,
  set as setSession,
  updateSessionData,
  remove as removeSession,
  createInitialState,
} from './sessionManager';
import { enqueueWebhookNotification } from '../services/discordWebhook';
import { updateActiveSessionsEmbed } from '../services/discordGateway';
import { getAll as getActiveSessions } from './sessionManager';
import {
  WsIncomingMessage,
  WsOutgoingMessage,
  WsAuthMessage,
  WsSessionMessage,
  SessionData,
} from '../types';

function send(ws: WebSocket, msg: WsOutgoingMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export async function handleAuth(ws: WebSocket, msg: WsAuthMessage): Promise<void> {
  const { username, token } = msg;

  if (!username || !token) {
    send(ws, { type: 'AUTH_FAILURE', reason: 'username and token are required' });
    return;
  }

  let user = await User.findOne({ username });

  if (!user) {
    // New user — auto-create with a placeholder password hash; they need the setup link to set one
        const passwordHash = await bcrypt.hash(randomUUID(), 12);
    user = await User.create({
      username,
      passwordHash,
      token,
      isAdmin: false,
      setupLinkUsed: false,
    });
  } else if (user.token !== token) {
    console.log(`WS AUTH_FAILURE for "${username}": token mismatch`);
    send(ws, { type: 'AUTH_FAILURE', reason: 'Invalid token' });
    return;
  }

  // Archive any existing active session for this username before overwriting,
  // but only if it belongs to a DIFFERENT WebSocket connection.
  // When the plugin calls AUTH again on the *same* socket (e.g. to refresh the
  // setup link via requestSetupLink()), we must NOT archive the live session —
  // that would make the session disappear from the active-splashers view.
  const existing = getSession(username);
  const isSameSocket = existing?.ws === ws;
  if (existing?.authenticated && existing.sessionData && !isSameSocket) {
    console.log(`Re-auth for "${username}" with active session on different socket — archiving existing session`);
    await archiveSession(username, existing.sessionData);
  }

  const state = createInitialState(username, ws);
  state.authenticated = true;
  // Preserve session data when re-authing on the same socket so that the
  // active session remains visible without requiring a fresh SESSION_START.
  if (isSameSocket && existing?.sessionData) {
    state.sessionData = existing.sessionData;
    state.lastUpdate = existing.lastUpdate;
  }
  setSession(username, state);

  const setupRequired = !user.setupLinkUsed;
  const setupLink = setupRequired ? generateSetupLink(username) : undefined;

  console.log(`WS AUTH_SUCCESS for "${username}": setupRequired=${setupRequired}`);
  send(ws, { type: 'AUTH_SUCCESS', setupRequired, setupLink });
}

export function handleSessionStart(ws: WebSocket, msg: WsSessionMessage): void {
  const state = getSessionForSocket(ws);
  if (!state) return;

  updateSessionData(state.username, msg.sessionData);
  triggerEmbedUpdate();
  send(ws, { type: 'ACK' });
}

export function handleSessionUpdate(ws: WebSocket, msg: WsSessionMessage): void {
  const state = getSessionForSocket(ws);
  if (!state) return;

  updateSessionData(state.username, msg.sessionData);
  triggerEmbedUpdate();
  send(ws, { type: 'ACK' });
}

// ── Shared archive helper ─────────────────────────────────────────────────────

async function archiveSession(username: string, sessionData: SessionData): Promise<void> {
  const user = await User.findOne({ username });
  if (!user) return;

  const sessionId = randomUUID();
  const now = Date.now();
  try {
    await ArchivedSession.create({
      sessionId,
      createdTimestamp: now,
      finalizedTimestamp: now,
      userId: user._id,
      username,
      session: sessionData,
    });

    const webhookUrl = process.env.DISCORD_ARCHIVED_WEBHOOK_URL ?? '';
    enqueueWebhookNotification(webhookUrl, username, [
      {
        sessionId,
        createdTimestamp: now,
        finalizedTimestamp: now,
        syncedToServer: true,
        session: sessionData,
      },
    ]);
  } catch (err) {
    console.error(`Failed to archive session for "${username}":`, err);
  }
}

export async function handleSessionEnd(ws: WebSocket, msg: WsSessionMessage): Promise<void> {
  const state = getSessionForSocket(ws);
  if (!state) return;

  const { username } = state;
  updateSessionData(username, msg.sessionData);

  await archiveSession(username, msg.sessionData);
  removeSession(username);
  triggerEmbedUpdate();
  send(ws, { type: 'ACK' });
}

/**
 * Called when a WebSocket connection closes.
 * If the session had active data it is archived so nothing is lost.
 */
export async function handleDisconnect(ws: WebSocket): Promise<void> {
  const state = getSessionForSocket(ws);
  if (!state) return;

  const { username, sessionData } = state;
  removeSession(username);

  if (state.authenticated && sessionData) {
    console.log(`WS disconnected with active session for "${username}" — archiving`);
    await archiveSession(username, sessionData);
  }

  triggerEmbedUpdate();
}

/**
 * Sweep for sessions that have not sent any update for more than `maxAgeMs`.
 * Covers edge cases where the connection stays open but data stops flowing.
 */
export async function sweepInactiveSessions(maxAgeMs: number): Promise<void> {
  const now = Date.now();
  const stale = getActiveSessions().filter(
    (s) => s.authenticated && s.sessionData !== null && now - s.lastUpdate > maxAgeMs,
  );

  for (const state of stale) {
    console.log(`Sweeping inactive session for "${state.username}" (last update ${Math.round((now - state.lastUpdate) / 1000)}s ago)`);
    removeSession(state.username);
    await archiveSession(state.username, state.sessionData!);
  }

  if (stale.length > 0) {
    triggerEmbedUpdate();
  }
}

export async function handleMessage(ws: WebSocket, raw: string): Promise<void> {
  let msg: WsIncomingMessage;
  try {
    msg = JSON.parse(raw) as WsIncomingMessage;
  } catch {
    send(ws, { type: 'AUTH_FAILURE', reason: 'Invalid JSON' });
    return;
  }

  if (!msg?.type) {
    send(ws, { type: 'AUTH_FAILURE', reason: 'Missing message type' });
    return;
  }

  if (msg.type === 'AUTH') {
    await handleAuth(ws, msg as WsAuthMessage);
    return;
  }

  // All other messages require authentication
  const state = getSessionForSocket(ws);
  if (!state?.authenticated) {
    send(ws, { type: 'AUTH_FAILURE', reason: 'Not authenticated' });
    return;
  }

  const sessionMsg = msg as WsSessionMessage;
  switch (sessionMsg.type) {
    case 'SESSION_START':
      handleSessionStart(ws, sessionMsg);
      break;
    case 'SESSION_UPDATE':
      handleSessionUpdate(ws, sessionMsg);
      break;
    case 'SESSION_END':
      await handleSessionEnd(ws, sessionMsg);
      break;
    default:
      // Unknown type — silently ignore
      break;
  }
}

function getSessionForSocket(ws: WebSocket) {
  for (const state of getActiveSessions()) {
    if (state.ws === ws) return state;
  }
  return null;
}

let embedDebounceTimer: ReturnType<typeof setTimeout> | null = null;
function triggerEmbedUpdate(): void {
  if (embedDebounceTimer) clearTimeout(embedDebounceTimer);
  embedDebounceTimer = setTimeout(() => {
    updateActiveSessionsEmbed(getActiveSessions());
    embedDebounceTimer = null;
  }, 2000);
}
