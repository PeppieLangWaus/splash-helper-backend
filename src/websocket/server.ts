import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage, Server } from 'http';
import { handleMessage, handleDisconnect } from './handlers';

export function attachWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    console.log(`WS connection from ${req.socket.remoteAddress}`);

    ws.on('message', (data) => {
      const raw = data.toString();
      try {
        const parsed = JSON.parse(raw);
        console.log(`WS message: type=${parsed.type} username=${parsed.username ?? '?'}`);
      } catch { /* ignore */ }
      handleMessage(ws, raw).catch((err) => {
        console.error('WS message handler error:', err);
      });
    });

    ws.on('close', () => {
      handleDisconnect(ws).catch((err) => {
        console.error('WS disconnect handler error:', err);
      });
    });

    ws.on('error', (err) => {
      console.error('WS error:', err);
      handleDisconnect(ws).catch(() => { /* already logged */ });
    });
  });

  return wss;
}
