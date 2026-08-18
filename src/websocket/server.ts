import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage, Server } from 'http';
import { handleMessage, handleDisconnect } from './handlers';
import { log, logError } from '../utils/logger';
import { getCfConnectingIp } from '../utils/clientIp';

export function attachWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // This is a raw `http.IncomingMessage`, not an Express `Request` — it never goes through
    // Express's `trust proxy` machinery, so `req.socket.remoteAddress` here is always just the
    // immediate hop (nginx, or Cloudflare's edge IP once that's in front). Logging-only, so this
    // reads CF-Connecting-IP directly rather than pulling in getClientIp()'s req.ip fallback.
    log(`WS connection from ${getCfConnectingIp(req.headers) ?? req.socket.remoteAddress}`);

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

    ws.on('close', () => {
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
