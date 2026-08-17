import express from 'express';
import request from 'supertest';
import { rateLimit } from '../../middleware/rateLimit';

function buildApp(keyFn?: (req: express.Request) => string) {
  const app = express();
  app.use(express.json());
  app.use(rateLimit({ windowMs: 60_000, max: 2, keyFn }));
  app.post('/probe', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('rateLimit keyFn', () => {
  it('limits per-IP by default', async () => {
    const app = buildApp();
    await request(app).post('/probe').expect(200);
    await request(app).post('/probe').expect(200);
    await request(app).post('/probe').expect(429);
  });

  it('limits per-key when keyFn is provided, independent of other keys', async () => {
    const app = buildApp((req) => (req.body as { email?: string }).email ?? 'unknown');
    await request(app).post('/probe').send({ email: 'a@example.com' }).expect(200);
    await request(app).post('/probe').send({ email: 'a@example.com' }).expect(200);
    await request(app).post('/probe').send({ email: 'a@example.com' }).expect(429);
    await request(app).post('/probe').send({ email: 'b@example.com' }).expect(200);
  });
});
