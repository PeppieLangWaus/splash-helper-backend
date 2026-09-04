import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage, Server } from 'http';
import { handleMessage, handleDisconnect } from './handlers';
import { log, logError } from '../utils/logger';
import { getCfConnectingIp } from '../utils/clientIp';

/** Tracks liveness for the ping/pong heartbeat below. */
interface HeartbeatWebSocket extends WebSocket {
  isAlive?: boolean;
}

/** How often the server pings each open socket to check it's still alive. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How long an open connection gets to send its first well-formed app message (AUTH,
 * SUBSCRIBE_CHAT, etc.) before it's dropped. This endpoint sees a steady trickle of
 * connections from internet-wide scanners that complete the WS handshake and then just hold
 * the socket open sending nothing — indistinguishable from a slow real client until this timer
 * runs out. Real clients (the RuneLite plugin, the web frontend's chat viewer) always send
 * their first message within a second or two of connecting, so this is generous headroom for
 * them while still bounding how long a scanner can occupy a connection slot.
 */
const FIRST_MESSAGE_GRACE_MS = 8_000;

export function attachWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  // Neither this server nor any of the current clients (RuneLite plugin, web frontend) send
  // their own keepalive traffic, so a WS that's open but quiet between messages (e.g. a chat
  // viewer idling between broadcasts) looks indistinguishable from a live one right up until a
  // write actually fails. If a reverse proxy in front of this (Coolify/Traefik) has an idle
  // connection timeout, it can silently drop such a socket without either endpoint noticing —
  // the client then only discovers it's dead on its next reconnect-timer tick, producing a
  // steady trickle of fresh "WS connection from <ip>" log lines from a client that thinks it
  // never disconnected. Pinging periodically and terminating anything that didn't pong back
  // since the last check turns that into a prompt, detectable `close` instead.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((client) => {
      const ws = client as HeartbeatWebSocket;
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws: HeartbeatWebSocket, req: IncomingMessage) => {
    // This is a raw `http.IncomingMessage`, not an Express `Request` — it never goes through
    // Express's `trust proxy` machinery, so `req.socket.remoteAddress` here is always just the
    // immediate hop (nginx, or Cloudflare's edge IP once that's in front). Logging-only, so this
    // reads CF-Connecting-IP directly rather than pulling in getClientIp()'s req.ip fallback.
    const ip = getCfConnectingIp(req.headers) ?? req.socket.remoteAddress;
    const connectedAt = Date.now();
    log(`WS connection from ${ip}`);

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    let sentFirstMessage = false;
    const graceTimer = setTimeout(() => {
      if (sentFirstMessage || ws.readyState !== WebSocket.OPEN) return;
      log(`WS closing ${ip}: no message sent within ${FIRST_MESSAGE_GRACE_MS}ms of connecting`);
      ws.close(1008, 'No message received');
    }, FIRST_MESSAGE_GRACE_MS);

    ws.on('message', (data) => {
      const raw = data.toString();

      try {
        const parsed = JSON.parse(raw);
        // Any well-formed `{ type: ... }` counts as the client actually speaking the app
        // protocol, regardless of whether handleMessage() below ends up accepting it (e.g. bad
        // AUTH credentials) — that's a separate, already-handled failure mode. This is just
        // "is something on the other end that isn't a scanner idling on an open socket."
        if (typeof parsed?.type === 'string' && parsed.type.length > 0) {
          sentFirstMessage = true;
          clearTimeout(graceTimer);
        }
        const username = parsed.username ?? parsed.sessionData?.playerName ?? '?';
        log(`WS message: type=${parsed.type} username=${username}`);
      } catch { /* ignore */ }
      handleMessage(ws, raw).catch((err) => {
        logError('WS message handler error:', err);
      });
    });

    // Logged (unlike before) so a burst of near-instant reconnects from one IP is diagnosable
    // after the fact — code 1006 with a sub-second lifetime points at something killing the
    // connection outright (proxy/WAF, client network drop) rather than a normal idle timeout,
    // which would show a lifetime in the tens-of-seconds-plus range instead.
    ws.on('close', (code, reason) => {
      clearTimeout(graceTimer);
      const lifetimeMs = Date.now() - connectedAt;
      log(`WS closed for ${ip} after ${lifetimeMs}ms (code=${code}${reason.length ? `, reason=${reason.toString()}` : ''})`);
      handleDisconnect(ws).catch((err) => {
        logError('WS disconnect handler error:', err);
      });
    });

    ws.on('error', (err) => {
      clearTimeout(graceTimer);
      logError('WS error:', err);
      handleDisconnect(ws).catch(() => { /* already logged */ });
    });
  });

  return wss;
}
