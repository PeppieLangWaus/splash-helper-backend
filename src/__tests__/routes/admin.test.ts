import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';
import { ArchivedSession } from '../../models/ArchivedSession';
import { Community } from '../../models/Community';
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
    await createUser('admin', true);

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(3); // alice, bob, and the requesting admin itself
    // Ensure passwords are excluded
    for (const u of res.body.users) {
      expect(u.passwordHash).toBeUndefined();
    }
  });
});

describe('POST /api/admin/promote/:username', () => {
  it('returns 403 without ADMIN_SECRET header', async () => {
    await createUser('alice');
    await createUser('admin', true);
    const res = await request(app)
      .post('/api/admin/promote/alice')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 with wrong ADMIN_SECRET', async () => {
    await createUser('alice');
    await createUser('admin', true);
    const res = await request(app)
      .post('/api/admin/promote/alice')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`)
      .set('x-admin-secret', 'wrong-secret');
    expect(res.status).toBe(403);
  });

  it('toggles isAdmin for the user', async () => {
    await createUser('alice', false);
    await createUser('admin', true);

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
    await createUser('admin', true);
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
    await createUser('admin', true);
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
    await createUser('admin', true);
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
    await createUser('admin', true);

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
    await createUser('admin', true);
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
    await createUser('admin', true);
    const res = await request(app)
      .delete('/api/admin/sessions/nope')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/community-eligibility/:username', () => {
  it('toggles communityEligible for the user', async () => {
    await createUser('alice');
    await createUser('admin', true);

    const res1 = await request(app)
      .post('/api/admin/community-eligibility/alice')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res1.status).toBe(200);
    expect(res1.body.communityEligible).toBe(true);

    const res2 = await request(app)
      .post('/api/admin/community-eligibility/alice')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res2.status).toBe(200);
    expect(res2.body.communityEligible).toBe(false);
  });

  it('returns 404 for non-existent user', async () => {
    await createUser('admin', true);
    const res = await request(app)
      .post('/api/admin/community-eligibility/nobody')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(404);
  });

  it('returns 403 for non-admin user', async () => {
    await createUser('alice');
    const res = await request(app)
      .post('/api/admin/community-eligibility/alice')
      .set('Authorization', `Bearer ${makeToken('alice', false)}`);
    expect(res.status).toBe(403);
  });
});

describe('community member assignment', () => {
  it('assigns and removes a splasher from a community', async () => {
    const owner = await createUser('alice');
    const splasher = await createUser('carol');
    await createUser('admin', true);
    const community = await Community.create({ name: 'Test Community', ownerIds: [owner._id], memberUserIds: [] });

    const assignRes = await request(app)
      .post(`/api/admin/communities/${community._id}/members/carol`)
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(assignRes.status).toBe(200);

    let updated = await Community.findById(community._id).lean();
    expect(updated!.memberUserIds.map((id) => id.toString())).toContain(splasher._id.toString());

    const removeRes = await request(app)
      .delete(`/api/admin/communities/${community._id}/members/carol`)
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(removeRes.status).toBe(200);

    updated = await Community.findById(community._id).lean();
    expect(updated!.memberUserIds).toHaveLength(0);
  });

  it('returns 404 when assigning an unknown user', async () => {
    const owner = await createUser('alice');
    await createUser('admin', true);
    const community = await Community.create({ name: 'Test Community', ownerIds: [owner._id], memberUserIds: [] });

    const res = await request(app)
      .post(`/api/admin/communities/${community._id}/members/nobody`)
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/communities/:communityId/members (bulk)', () => {
  it('assigns multiple splashers to a community, skipping unknown usernames', async () => {
    const owner = await createUser('alice');
    const carol = await createUser('carol');
    const dave = await createUser('dave');
    await createUser('admin', true);
    const community = await Community.create({ name: 'Test Community', ownerIds: [owner._id], memberUserIds: [] });

    const res = await request(app)
      .post(`/api/admin/communities/${community._id}/members`)
      .set('Authorization', `Bearer ${makeToken('admin', true)}`)
      .send({ usernames: ['carol', 'dave', 'nobody'] });

    expect(res.status).toBe(200);
    expect(res.body.notFound).toEqual(['nobody']);

    const updated = await Community.findById(community._id).lean();
    const ids = updated!.memberUserIds.map((id) => id.toString());
    expect(ids).toContain(carol._id.toString());
    expect(ids).toContain(dave._id.toString());
    expect(ids).toHaveLength(2);
  });

  it('does not duplicate members already assigned', async () => {
    const owner = await createUser('alice');
    const carol = await createUser('carol');
    await createUser('admin', true);
    const community = await Community.create({
      name: 'Test Community',
      ownerIds: [owner._id],
      memberUserIds: [carol._id],
    });

    const res = await request(app)
      .post(`/api/admin/communities/${community._id}/members`)
      .set('Authorization', `Bearer ${makeToken('admin', true)}`)
      .send({ usernames: ['carol'] });

    expect(res.status).toBe(200);
    const updated = await Community.findById(community._id).lean();
    expect(updated!.memberUserIds).toHaveLength(1);
  });

  it('returns 400 for an empty usernames array', async () => {
    const owner = await createUser('alice');
    await createUser('admin', true);
    const community = await Community.create({ name: 'Test Community', ownerIds: [owner._id], memberUserIds: [] });

    const res = await request(app)
      .post(`/api/admin/communities/${community._id}/members`)
      .set('Authorization', `Bearer ${makeToken('admin', true)}`)
      .send({ usernames: [] });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown community', async () => {
    await createUser('admin', true);
    const res = await request(app)
      .post('/api/admin/communities/000000000000000000000000/members')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`)
      .send({ usernames: ['carol'] });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/admin/communities', () => {
  it('returns all communities', async () => {
    const owner = await createUser('alice');
    await createUser('admin', true);
    await Community.create({ name: 'Community A', ownerIds: [owner._id], memberUserIds: [] });
    await Community.create({ name: 'Community B', ownerIds: [owner._id], memberUserIds: [] });

    const res = await request(app)
      .get('/api/admin/communities')
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(200);
    expect(res.body.communities).toHaveLength(2);
  });
});
