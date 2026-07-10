import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';
import { ArchivedSession } from '../../models/ArchivedSession';
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
    const res = await request(app)
      .get('/api/splashers/nobody')
      .set('Authorization', `Bearer ${makeToken('nobody')}`);
    expect(res.status).toBe(404);
  });
});
