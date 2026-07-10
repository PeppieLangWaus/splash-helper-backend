import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';
import { ArchivedSession } from '../../models/ArchivedSession';
import { makeSessionData } from '../fixtures';

const app = createTestApp();
const JWT_SECRET = 'test-jwt-secret';
const ADMIN_SECRET = 'test-admin-secret';

function makeToken(username: string, isAdmin = false) {
  return jwt.sign({ sub: username, isAdmin }, JWT_SECRET, { expiresIn: '1h' });
}

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
});

async function createUser(username: string, isAdmin = false) {
  const hash = await bcrypt.hash('password', 12);
  return User.create({ username, passwordHash: hash, token: `token-${username}`, isAdmin, setupLinkUsed: true });
}

describe('GET /api/admin/users', () => {
  it('returns 401 without auth', async () => {
    await request(app).get('/api/admin/users').expect(401);
  });

  it('returns 403 for non-admin user', async () => {
    await createUser('alice');
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${makeToken('alice', false)}`);
    expect(res.status).toBe(403);
  });

  it('returns all users for admin', async () => {
    await createUser('alice');
    await createUser('bob');

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    // Ensure passwords are excluded
    for (const u of res.body.users) {
      expect(u.passwordHash).toBeUndefined();
    }
  });
});

describe('POST /api/admin/promote/:username', () => {
  it('returns 403 without ADMIN_SECRET header', async () => {
    await createUser('alice');
    const res = await request(app)
      .post('/api/admin/promote/alice')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 with wrong ADMIN_SECRET', async () => {
    await createUser('alice');
    const res = await request(app)
      .post('/api/admin/promote/alice')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`)
      .set('x-admin-secret', 'wrong-secret');
    expect(res.status).toBe(403);
  });

  it('toggles isAdmin for the user', async () => {
    await createUser('alice', false);

    // Promote
    const res1 = await request(app)
      .post('/api/admin/promote/alice')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`)
      .set('x-admin-secret', ADMIN_SECRET);
    expect(res1.status).toBe(200);
    expect(res1.body.isAdmin).toBe(true);

    // Demote
    const res2 = await request(app)
      .post('/api/admin/promote/alice')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`)
      .set('x-admin-secret', ADMIN_SECRET);
    expect(res2.status).toBe(200);
    expect(res2.body.isAdmin).toBe(false);
  });

  it('returns 404 for non-existent user', async () => {
    const res = await request(app)
      .post('/api/admin/promote/nobody')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`)
      .set('x-admin-secret', ADMIN_SECRET);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/admin/users/:username', () => {
  it('deletes user and their sessions', async () => {
    const user = await createUser('alice');
    await ArchivedSession.create({
      sessionId: 'sid1',
      createdTimestamp: 1000,
      finalizedTimestamp: 2000,
      userId: user._id,
      username: 'alice',
      session: makeSessionData({ playerName: 'alice' }),
    });

    const res = await request(app)
      .delete('/api/admin/users/alice')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(200);

    expect(await User.findOne({ username: 'alice' })).toBeNull();
    expect(await ArchivedSession.countDocuments({ username: 'alice' })).toBe(0);
  });

  it('returns 404 for unknown user', async () => {
    const res = await request(app)
      .delete('/api/admin/users/nobody')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/admin/sessions', () => {
  it('returns all sessions across all users', async () => {
    const u1 = await createUser('alice');
    const u2 = await createUser('bob');

    await ArchivedSession.create({
      sessionId: 'sid-a',
      createdTimestamp: 100,
      finalizedTimestamp: 200,
      userId: u1._id,
      username: 'alice',
      session: makeSessionData({ playerName: 'alice' }),
    });

    await ArchivedSession.create({
      sessionId: 'sid-b',
      createdTimestamp: 300,
      finalizedTimestamp: 400,
      userId: u2._id,
      username: 'bob',
      session: makeSessionData({ playerName: 'bob' }),
    });

    const res = await request(app)
      .get('/api/admin/sessions')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
  });
});

describe('DELETE /api/admin/sessions/:sessionId', () => {
  it('deletes specified session', async () => {
    const user = await createUser('alice');
    await ArchivedSession.create({
      sessionId: 'del-sid',
      createdTimestamp: 1000,
      finalizedTimestamp: 2000,
      userId: user._id,
      username: 'alice',
      session: makeSessionData({ playerName: 'alice' }),
    });

    const res = await request(app)
      .delete('/api/admin/sessions/del-sid')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(200);
    expect(await ArchivedSession.countDocuments({ sessionId: 'del-sid' })).toBe(0);
  });

  it('returns 404 for unknown session', async () => {
    const res = await request(app)
      .delete('/api/admin/sessions/nope')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(404);
  });
});
