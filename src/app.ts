import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { connectDB } from './db';
import { migrateLegacyChatWebhooks } from './services/chatWebhookMigration';
import { syncChatChannelNameIndexes } from './models/ChatChannelName';
import splashersRouter from './routes/splashers';
import sessionsRouter from './routes/sessions';
import authRouter from './routes/auth';
import adminRouter from './routes/admin';
import communitiesRouter from './routes/communities';
import communityBotRouter from './routes/communityBot';
import chatRelayRouter from './routes/chatRelay';
import chatChannelsRouter from './routes/chatChannels';
import itemsRouter from './routes/items';
import devRouter from './routes/dev';
import { notFoundLogger, invalidBodyLogger } from './middleware/invalidRequestLogger';
import { attachWebSocketServer } from './websocket/server';
import { sweepInactiveSessions } from './websocket/handlers';

// Sessions inactive for more than 5 minutes are auto-archived
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 2 * 60 * 1000; // check every 2 minutes

const app = express();
const PORT = process.env.PORT ?? 3000;

// Two hops in front of this app: Cloudflare's edge, then nginx (see nginx/splasher.help.conf).
// `trust proxy` has to count both or req.ip resolves to the wrong hop. That said, most IP uses
// in this codebase (see utils/clientIp.ts) prefer Cloudflare's CF-Connecting-IP header over
// req.ip specifically so they don't depend on this hop count staying accurate — this still needs
// to be right for req.ip itself and anything (e.g. express libs) that reads it directly.
app.set('trust proxy', 2);

const allowedOrigins = (process.env.CORS_ORIGIN_API ?? process.env.CORS_ORIGIN_WS)
  ?.split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins,
}));
app.use(express.json({
  limit: '10mb',
  // Stashes the raw body text before parsing, so invalidRequestLogger can still record what a
  // scanner sent even when it's not valid JSON (req.body is never populated in that case).
  verify: (req, _res, buf) => {
    (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8').slice(0, 2000);
  },
}));

app.use('/splashers', splashersRouter);
app.use('/sessions', sessionsRouter);
app.use('/auth', authRouter);
app.use('/admin', adminRouter);
app.use('/communities', communitiesRouter);
app.use('/community-bot', communityBotRouter);
app.use('/chat-relay', chatRelayRouter);
app.use('/chat-channels', chatChannelsRouter);
app.use('/items', itemsRouter);

if (process.env.NODE_ENV !== 'production') {
  app.use('/dev', devRouter);
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Must come after every route above: logs+responds to anything that didn't match a real route
// (mostly exploit-scanner probes) or that sent a body express.json() couldn't parse.
app.use(notFoundLogger);
app.use(invalidBodyLogger);

const httpServer = http.createServer(app);
attachWebSocketServer(httpServer);

async function start(): Promise<void> {
  await connectDB();
  await migrateLegacyChatWebhooks();
  await syncChatChannelNameIndexes();
  httpServer.listen(PORT, () => {
    console.log(`Splash Helper API listening on http://localhost:${PORT}`);
  });

  setInterval(() => {
    sweepInactiveSessions(INACTIVITY_TIMEOUT_MS).catch((err) => {
      console.error('Inactivity sweep error:', err);
    });
  }, SWEEP_INTERVAL_MS);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export { app, httpServer };
export default app;
