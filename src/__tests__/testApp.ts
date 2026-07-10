/**
 * Returns a fully configured Express app for Supertest, without starting the
 * HTTP server or connecting to MongoDB (tests connect/disconnect themselves).
 */
import express from 'express';
import cors from 'cors';
import splashersRouter from '../routes/splashers';
import sessionsRouter from '../routes/sessions';
import authRouter from '../routes/auth';
import adminRouter from '../routes/admin';

export function createTestApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/splashers', splashersRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  return app;
}
