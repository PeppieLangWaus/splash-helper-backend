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
  clearSessionData,
  createInitialState,
} from './sessionManager';
import { upsertArchivedSessionNotification } from '../services/discordWebhook';
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

  // Preserve any in-progress session across re-AUTH, regardless of whether
  // it's the same socket (e.g. requestSetupLink()) or a new one (e.g. the
  // plugin reconnecting after a dropped connection). Archiving here would
  // fragment one continuous splash session into several tiny archived ones
  // every time the connection blips. A session is only archived on an
  // explicit SESSION_END, or by the inactivity sweep if the client never
  // reconnects.
  const existing = getSession(username);
  const state = createInitialState(username, ws);
  state.authenticated = true;
  if (existing?.sessionData) {
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

function toTimestamp(value: string | undefined, fallback: number, label: string): number {
  if (!value) {
    console.warn(`archiveSession: missing ${label}, falling back to current time`);
    return fallback;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    console.warn(`archiveSession: unparseable ${label} "${value}", falling back to current time`);
    return fallback;
  }
  return parsed;
}

async function archiveSession(username: string, sessionData: SessionData): Promise<void> {
  const user = await User.findOne({ username });
  if (!user) return;

  const now = Date.now();
  // Use the session's own start/end times rather than "now" — "now" is when
  // it happened to be archived (e.g. a disconnect or sweep), not when the
  // splash session actually took place.
  const createdTimestamp = toTimestamp(sessionData.startTime, now, 'startTime');
  const finalizedTimestamp = toTimestamp(sessionData.endTime ?? sessionData.logoutTime, now, 'endTime/logoutTime');

  try {
    // A session that gets finalized on a brief inactivity timeout, then resumed and
    // finalized again later, shares the same startTime (createdTimestamp) across those
    // finalizations. Look for that existing record instead of always inserting a new one,
    // so the resumed continuation updates it in place rather than archiving (and
    // webhook-notifying) the same splash session again as a sibling entry.
    const existing = await ArchivedSession.findOne({ userId: user._id, createdTimestamp });

    if (existing) {
      if (finalizedTimestamp <= existing.finalizedTimestamp) {
        console.warn(
          `archiveSession: ignoring stale/out-of-order resend for "${username}" (createdTimestamp=${createdTimestamp})`,
        );
        return;
      }

      existing.finalizedTimestamp = finalizedTimestamp;
      existing.session = sessionData;
      await existing.save();

      const webhookUrl = process.env.DISCORD_ARCHIVED_WEBHOOK_URL ?? '';
      const messageId = await upsertArchivedSessionNotification(
        webhookUrl,
        username,
        {
          sessionId: existing.sessionId,
          createdTimestamp,
          finalizedTimestamp,
          syncedToServer: true,
          session: sessionData,
        },
        existing.discordMessageId,
      );
      if (messageId && messageId !== existing.discordMessageId) {
        existing.discordMessageId = messageId;
        await existing.save();
      }
      return;
    }

    const sessionId = randomUUID();
    const created = await ArchivedSession.create({
      sessionId,
      createdTimestamp,
      finalizedTimestamp,
      userId: user._id,
      username,
      session: sessionData,
    });

    const webhookUrl = process.env.DISCORD_ARCHIVED_WEBHOOK_URL ?? '';
    const messageId = await upsertArchivedSessionNotification(webhookUrl, username, {
      sessionId,
      createdTimestamp,
      finalizedTimestamp,
      syncedToServer: true,
      session: sessionData,
    });
    if (messageId) {
      created.discordMessageId = messageId;
      await created.save();
    }
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
  // Clear the finished session's data but keep the connection's authenticated state intact:
  // the plugin can resume this same splash (its resume window) on the same still-open socket
  // by sending a fresh SESSION_START without re-AUTHing, and that must still resolve via
  // getSessionForSocket() rather than being silently dropped because the whole record for this
  // connection was torn down.
  clearSessionData(username);
  triggerEmbedUpdate();
  send(ws, { type: 'ACK' });
}

/**
 * Called when a WebSocket connection closes.
 * A session still in progress is kept in memory rather than archived immediately, since the
 * client typically reconnects (network blip, client restart) and resumes the same splash
 * session. It's only archived via an explicit SESSION_END, or by the inactivity sweep if the
 * client never comes back. If no session is in progress (already finalized via SESSION_END,
 * or never started), there is nothing worth preserving across a reconnect, so the entry is
 * removed now rather than lingering — the inactivity sweep only clears entries that still have
 * session data, so an idle authenticated placeholder would otherwise never be cleaned up.
 */
export async function handleDisconnect(ws: WebSocket): Promise<void> {
  const state = getSessionForSocket(ws);
  if (!state) return;

  console.log(`WS disconnected for "${state.username}"`);
  if (state.sessionData === null) {
    removeSession(state.username);
  }
  triggerEmbedUpdate();
}

let sweepInProgress = false;

/**
 * Sweep for disconnected sessions that have not sent any update for more than
 * `maxAgeMs`. Requires the socket to actually be closed (not just quiet) so
 * that a still-connected session that's merely idle (e.g. banking, AFK) is
 * never archived out from under an active plugin — only SESSION_END or a
 * genuine disconnect-then-timeout should end a session.
 */
export async function sweepInactiveSessions(maxAgeMs: number): Promise<void> {
  if (sweepInProgress) {
    console.log('Sweep already in progress, skipping this tick');
    return;
  }
  sweepInProgress = true;

  try {
    const now = Date.now();
    const stale = getActiveSessions().filter(
      (s) =>
        s.authenticated &&
        s.sessionData !== null &&
        s.ws.readyState !== WebSocket.OPEN &&
        now - s.lastUpdate > maxAgeMs,
    );

    for (const state of stale) {
      // Re-check under the map: a prior iteration's archiveSession() await
      // may have let a reconnect or SESSION_END remove/replace this entry.
      if (getSession(state.username) !== state) continue;

      console.log(`Sweeping inactive session for "${state.username}" (last update ${Math.round((now - state.lastUpdate) / 1000)}s ago)`);
      removeSession(state.username);
      await archiveSession(state.username, state.sessionData!);
    }

    if (stale.length > 0) {
      triggerEmbedUpdate();
    }
  } finally {
    sweepInProgress = false;
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

function triggerEmbedUpdate(): void {
  updateActiveSessionsEmbed(getActiveSessions());
}
