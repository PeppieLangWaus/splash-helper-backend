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

    ws.on('message', (data) => {
      const raw = data.toString();

      try {
        const parsed = JSON.parse(raw);
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
      const lifetimeMs = Date.now() - connectedAt;
      log(`WS closed for ${ip} after ${lifetimeMs}ms (code=${code}${reason.length ? `, reason=${reason.toString()}` : ''})`);
      handleDisconnect(ws).catch((err) => {
        logError('WS disconnect handler error:', err);
      });
    });

    ws.on('error', (err) => {
      logError('WS error:', err);
      handleDisconnect(ws).catch(() => { /* already logged */ });
    });
  });

  return wss;
}
