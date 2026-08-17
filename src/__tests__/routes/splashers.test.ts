import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';
import { ArchivedSession } from '../../models/ArchivedSession';
import { Community } from '../../models/Community';
import { makeSessionData } from '../fixtures';
import * as sessionManager from '../../websocket/sessionManager';
import { WebSocket } from 'ws';

const app = createTestApp();
const JWT_SECRET = 'test-jwt-secret';

function makeToken(username: string, isAdmin = false) {
  return jwt.sign({ sub: username, isAdmin }, JWT_SECRET, { expiresIn: '1h' });
}

// A stub ws object for sessionManager
const stubWs = {} as WebSocket;

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
  // Clear in-memory session store between tests
  sessionManager.getAll().forEach((s) => sessionManager.remove(s.username));
});

describe('GET /api/splashers', () => {
  it('returns empty sessions when no active sessions', async () => {
    const res = await request(app).get('/api/splashers');
    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });

  it('returns only authenticated sessions with session data', async () => {
    const state = sessionManager.createInitialState('Player1', stubWs);
    state.authenticated = true;
    state.sessionData = makeSessionData({ playerName: 'Player1' });
    sessionManager.set('Player1', state);

    // unauthenticated session — should be excluded
    const unauthState = sessionManager.createInitialState('Player2', stubWs);
    sessionManager.set('Player2', unauthState);

    const res = await request(app).get('/api/splashers');
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].username).toBe('Player1');
  });
});

describe('GET /api/splashers/:username', () => {
  it('returns 401 without auth token', async () => {
    await request(app).get('/api/splashers/alice').expect(401);
  });

  it('returns 403 when requesting another user\'s data', async () => {
    const hash = await bcrypt.hash('pass', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 't1', setupLinkUsed: true });
    await User.create({ username: 'bob', passwordHash: hash, token: 't2', setupLinkUsed: true });

    const res = await request(app)
      .get('/api/splashers/alice')
      .set('Authorization', `Bearer ${makeToken('bob')}`);
    expect(res.status).toBe(403);
  });

  it('returns own archived sessions when authenticated', async () => {
    const hash = await bcrypt.hash('pass', 12);
    const user = await User.create({ username: 'alice', passwordHash: hash, token: 't1', setupLinkUsed: true });

    await ArchivedSession.create({
      sessionId: 's1',
      createdTimestamp: Date.now(),
      finalizedTimestamp: Date.now() + 1000,
      userId: user._id,
      username: 'alice',
      session: makeSessionData({ playerName: 'alice' }),
    });

    const res = await request(app)
      .get('/api/splashers/alice')
      .set('Authorization', `Bearer ${makeToken('alice')}`);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
  });

  it('admin can access any user\'s data', async () => {
    const hash = await bcrypt.hash('pass', 12);
    const user = await User.create({ username: 'alice', passwordHash: hash, token: 't1', setupLinkUsed: true });
    // requireAuth (see middleware/auth.ts) now checks tokenVersion against a real User document,
    // so the token's subject has to actually exist — not just claim isAdmin in the payload.
    await User.create({ username: 'admin', passwordHash: hash, token: 'admin-tok', isAdmin: true, setupLinkUsed: true });

    await ArchivedSession.create({
      sessionId: 's2',
      createdTimestamp: Date.now(),
      finalizedTimestamp: Date.now() + 1000,
      userId: user._id,
      username: 'alice',
      session: makeSessionData({ playerName: 'alice' }),
    });

    const res = await request(app)
      .get('/api/splashers/alice')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
  });

  it('returns 404 for unknown user', async () => {
    const hash = await bcrypt.hash('pass', 12);
    // The requester has to be a real user (requireAuth checks tokenVersion against an actual
    // User document) — this test is about the *target* username being unknown, not the caller.
    await User.create({ username: 'admin', passwordHash: hash, token: 'admin-tok', isAdmin: true, setupLinkUsed: true });

    const res = await request(app)
      .get('/api/splashers/nobody')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(404);
  });

  it('allows a community owner to access an assigned splasher\'s data', async () => {
    const hash = await bcrypt.hash('pass', 12);
    const owner = await User.create({ username: 'alice', passwordHash: hash, token: 't1', setupLinkUsed: true, communityEligible: true });
    const splasher = await User.create({ username: 'carol', passwordHash: hash, token: 't2', setupLinkUsed: true });
    await Community.create({ name: 'Alice Community', ownerIds: [owner._id], memberUserIds: [splasher._id] });

    await ArchivedSession.create({
      sessionId: 's3',
      createdTimestamp: Date.now(),
      finalizedTimestamp: Date.now() + 1000,
      userId: splasher._id,
      username: 'carol',
      session: makeSessionData({ playerName: 'carol' }),
    });

    const res = await request(app)
      .get('/api/splashers/carol')
      .set('Authorization', `Bearer ${makeToken('alice')}`);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
  });

  it('denies access to a splasher not assigned to the requester\'s community', async () => {
    const hash = await bcrypt.hash('pass', 12);
    const owner = await User.create({ username: 'alice', passwordHash: hash, token: 't1', setupLinkUsed: true, communityEligible: true });
    await User.create({ username: 'carol', passwordHash: hash, token: 't2', setupLinkUsed: true });
    await Community.create({ name: 'Alice Community', ownerIds: [owner._id], memberUserIds: [] });

    const res = await request(app)
      .get('/api/splashers/carol')
      .set('Authorization', `Bearer ${makeToken('alice')}`);
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/splashers/:username/webhook', () => {
  const VALID_WEBHOOK = 'https://discord.com/api/webhooks/123456789/abcDEF-123';

  it('returns 401 without auth token', async () => {
    await request(app).put('/api/splashers/alice/webhook').send({ activeWebhookUrl: VALID_WEBHOOK }).expect(401);
  });

  it('allows a splasher to set their own webhooks', async () => {
    const hash = await bcrypt.hash('pass', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 't1', setupLinkUsed: true });

    const res = await request(app)
      .put('/api/splashers/alice/webhook')
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ activeWebhookUrl: VALID_WEBHOOK, historyWebhookUrl: VALID_WEBHOOK });
    expect(res.status).toBe(200);
    expect(res.body.discordActiveWebhookUrl).toBe(VALID_WEBHOOK);
    expect(res.body.discordHistoryWebhookUrl).toBe(VALID_WEBHOOK);

    const reloaded = await User.findOne({ username: 'alice' }).lean();
    expect(reloaded!.discordActiveWebhookUrl).toBe(VALID_WEBHOOK);
  });

  it('denies a splasher setting another splasher\'s webhook without ownership', async () => {
    const hash = await bcrypt.hash('pass', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 't1', setupLinkUsed: true });
    await User.create({ username: 'bob', passwordHash: hash, token: 't2', setupLinkUsed: true });

    const res = await request(app)
      .put('/api/splashers/bob/webhook')
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ activeWebhookUrl: VALID_WEBHOOK });
    expect(res.status).toBe(403);
  });

  it('allows a community owner to set a member\'s webhook', async () => {
    const hash = await bcrypt.hash('pass', 12);
    const owner = await User.create({ username: 'alice', passwordHash: hash, token: 't1', setupLinkUsed: true, communityEligible: true });
    const splasher = await User.create({ username: 'carol', passwordHash: hash, token: 't2', setupLinkUsed: true });
    await Community.create({ name: 'Alice Community', ownerIds: [owner._id], memberUserIds: [splasher._id] });

    const res = await request(app)
      .put('/api/splashers/carol/webhook')
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ activeWebhookUrl: VALID_WEBHOOK });
    expect(res.status).toBe(200);
    expect(res.body.discordActiveWebhookUrl).toBe(VALID_WEBHOOK);
  });

  it('rejects an invalid webhook URL', async () => {
    const hash = await bcrypt.hash('pass', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 't1', setupLinkUsed: true });

    const res = await request(app)
      .put('/api/splashers/alice/webhook')
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ activeWebhookUrl: 'not-a-webhook' });
    expect(res.status).toBe(400);
  });

  it('clears a webhook when given an empty value, leaving the other field untouched', async () => {
    const hash = await bcrypt.hash('pass', 12);
    await User.create({
      username: 'alice',
      passwordHash: hash,
      token: 't1',
      setupLinkUsed: true,
      discordActiveWebhookUrl: VALID_WEBHOOK,
      discordHistoryWebhookUrl: VALID_WEBHOOK,
    });

    const res = await request(app)
      .put('/api/splashers/alice/webhook')
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ activeWebhookUrl: '' });
    expect(res.status).toBe(200);
    expect(res.body.discordActiveWebhookUrl).toBeUndefined();
    expect(res.body.discordHistoryWebhookUrl).toBe(VALID_WEBHOOK);
  });
});
