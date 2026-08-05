import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage, Server } from 'http';
import { handleMessage, handleDisconnect } from './handlers';
import { log, logError } from '../utils/logger';

export function attachWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    log(`WS connection from ${req.socket.remoteAddress}`);

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
