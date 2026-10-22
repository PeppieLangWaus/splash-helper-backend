import express from 'express';
import request from 'supertest';
import { notFoundLogger, invalidBodyLogger } from '../../middleware/invalidRequestLogger';

function buildApp() {
  const app = express();
  app.use(express.json({
    limit: '20b',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  }));
  app.get('/known', (_req, res) => res.json({ ok: true }));
  app.use(notFoundLogger);
  app.use(invalidBodyLogger);
  return app;
}

// getClientIp() keys off CF-Connecting-IP (see utils/clientIp.ts), not X-Forwarded-For -- and the
// per-IP log budget below is deliberately module-level state that outlives a single request, so
// tests must give each case its own IP or they'll starve each other's budget.
let nextTestIp = 1;
function freshIp(): string {
  nextTestIp += 1;
  return `10.0.0.${nextTestIp}`;
}

function loggedEvents(warnSpy: jest.SpyInstance): Array<Record<string, unknown>> {
  return warnSpy.mock.calls.map(([line]) => JSON.parse(line as string));
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('notFoundLogger', () => {
  it('responds 404 and does not log a route that actually exists', async () => {
    const app = buildApp();
    await request(app).get('/known').set('CF-Connecting-IP', freshIp()).expect(200);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs unmatched routes with method, path, ip, and sanitized headers', async () => {
    const app = buildApp();
    const ip = freshIp();
    await request(app)
      .get('/wp-login.php?a=1')
      .set('CF-Connecting-IP', ip)
      .set('Authorization', 'Bearer super-secret')
      .set('User-Agent', 'ExploitScanner/1.0')
      .expect(404);

    const events = loggedEvents(warnSpy);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'invalid_request',
      method: 'GET',
      path: '/wp-login.php?a=1',
      ip,
      statusCode: 404,
      reason: 'not-found',
    });
    expect((events[0].headers as Record<string, string>).authorization).toBe('[redacted]');
    expect((events[0].headers as Record<string, string>)['user-agent']).toBe('ExploitScanner/1.0');
  });

  it('stops logging a single IP after it exceeds the per-window budget', async () => {
    const app = buildApp();
    const ip = freshIp();
    for (let i = 0; i < 35; i++) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).get(`/probe-${i}`).set('CF-Connecting-IP', ip).expect(404);
    }
    expect(warnSpy).toHaveBeenCalledTimes(30);
  });

  it('logs unmatched routes from a different IP independently of an exhausted one', async () => {
    const app = buildApp();
    const busyIp = freshIp();
    for (let i = 0; i < 30; i++) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).get(`/busy-${i}`).set('CF-Connecting-IP', busyIp).expect(404);
    }

    const otherIp = freshIp();
    await request(app).get('/quiet').set('CF-Connecting-IP', otherIp).expect(404);

    const events = loggedEvents(warnSpy);
    expect(events.filter((e) => e.ip === otherIp)).toHaveLength(1);
  });
});

describe('invalidBodyLogger', () => {
  it('logs malformed JSON with the raw body and responds 400', async () => {
    const app = buildApp();
    await request(app)
      .post('/known')
      .set('CF-Connecting-IP', freshIp())
      .set('Content-Type', 'application/json')
      .send('{not valid json')
      .expect(400);

    const events = loggedEvents(warnSpy);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('invalid-json');
    expect(events[0].body).toContain('{not valid json');
  });

  it('logs oversized payloads without a body and responds 413', async () => {
    const app = buildApp();
    await request(app)
      .post('/known')
      .set('CF-Connecting-IP', freshIp())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ big: 'x'.repeat(100) }))
      .expect(413);

    const events = loggedEvents(warnSpy);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('payload-too-large');
    expect(events[0].body).toBeUndefined();
  });
});
