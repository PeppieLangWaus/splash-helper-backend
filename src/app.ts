import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { connectDB } from './db';
import splashersRouter from './routes/splashers';
import sessionsRouter from './routes/sessions';
import authRouter from './routes/auth';
import adminRouter from './routes/admin';
import { attachWebSocketServer } from './websocket/server';
import { sweepInactiveSessions } from './websocket/handlers';

// Sessions inactive for more than 5 minutes are auto-archived
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 2 * 60 * 1000; // check every 2 minutes

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors({
  origin: process.env.CORS_ORIGIN_API ?? process.env.CORS_ORIGIN_WS,
}));
app.use(express.json({ limit: '10mb' }));

app.use('/splashers', splashersRouter);
app.use('/sessions', sessionsRouter);
app.use('/auth', authRouter);
app.use('/admin', adminRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const httpServer = http.createServer(app);
attachWebSocketServer(httpServer);

async function start(): Promise<void> {
  await connectDB();
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
