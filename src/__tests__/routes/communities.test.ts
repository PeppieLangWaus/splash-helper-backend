import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';
import { Community } from '../../models/Community';
import { ArchivedSession } from '../../models/ArchivedSession';
import { makeSessionData } from '../fixtures';

const app = createTestApp();
const JWT_SECRET = 'test-jwt-secret';

function makeToken(username: string, isAdmin = false, communityEligible = false) {
  return jwt.sign({ sub: username, isAdmin, communityEligible }, JWT_SECRET, { expiresIn: '1h' });
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

async function createUser(username: string, opts: { isAdmin?: boolean; communityEligible?: boolean } = {}) {
  const hash = await bcrypt.hash('password', 12);
  return User.create({
    username,
    passwordHash: hash,
    token: `token-${username}`,
    isAdmin: opts.isAdmin ?? false,
    setupLinkUsed: true,
    communityEligible: opts.communityEligible ?? false,
  });
}

describe('POST /api/communities', () => {
  it('returns 401 without auth', async () => {
    await request(app).post('/api/communities').send({ name: 'My Community' }).expect(401);
  });

  it('returns 403 when the user is not communityEligible in the DB', async () => {
    await createUser('alice', { communityEligible: false });
    const res = await request(app)
      .post('/api/communities')
      .set('Authorization', `Bearer ${makeToken('alice', false, true)}`) // stale/forged claim
      .send({ name: 'My Community' });
    expect(res.status).toBe(403);
  });

  it('returns 400 without a name', async () => {
    await createUser('alice', { communityEligible: true });
    const res = await request(app)
      .post('/api/communities')
      .set('Authorization', `Bearer ${makeToken('alice', false, true)}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('creates a community owned by the requester when eligible', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const res = await request(app)
      .post('/api/communities')
      .set('Authorization', `Bearer ${makeToken('alice', false, true)}`)
      .send({ name: 'My Community' });
    expect(res.status).toBe(201);
    expect(res.body.community.name).toBe('My Community');
    expect(res.body.community.ownerIds).toEqual([alice._id.toString()]);
  });
});

describe('GET /api/communities/mine', () => {
  it('returns only communities owned by the requester', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    await createUser('bob', { communityEligible: true });

    await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .get('/api/communities/mine')
      .set('Authorization', `Bearer ${makeToken('alice')}`);
    expect(res.status).toBe(200);
    expect(res.body.communities).toHaveLength(1);
    expect(res.body.communities[0].name).toBe('Alice Community');

    const resBob = await request(app)
      .get('/api/communities/mine')
      .set('Authorization', `Bearer ${makeToken('bob')}`);
    expect(resBob.body.communities).toHaveLength(0);
  });
});

describe('GET /api/communities/:communityId/splashers and /sessions', () => {
  it('denies access to a non-owner, non-admin user', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    await createUser('mallory');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .get(`/api/communities/${community._id}/splashers`)
      .set('Authorization', `Bearer ${makeToken('mallory')}`);
    expect(res.status).toBe(403);
  });

  it('returns assigned splashers and their archived sessions for the owner', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const carol = await createUser('carol');
    const community = await Community.create({
      name: 'Alice Community',
      ownerIds: [alice._id],
      memberUserIds: [carol._id],
    });

    await ArchivedSession.create({
      sessionId: 'sid-carol',
      createdTimestamp: 100,
      finalizedTimestamp: 200,
      userId: carol._id,
      username: 'carol',
      session: makeSessionData({ playerName: 'carol' }),
    });

    const splashersRes = await request(app)
      .get(`/api/communities/${community._id}/splashers`)
      .set('Authorization', `Bearer ${makeToken('alice')}`);
    expect(splashersRes.status).toBe(200);
    expect(splashersRes.body.splashers).toHaveLength(1);
    expect(splashersRes.body.splashers[0].username).toBe('carol');
    expect(splashersRes.body.splashers[0].passwordHash).toBeUndefined();

    const sessionsRes = await request(app)
      .get(`/api/communities/${community._id}/sessions`)
      .set('Authorization', `Bearer ${makeToken('alice')}`);
    expect(sessionsRes.status).toBe(200);
    expect(sessionsRes.body.sessions).toHaveLength(1);
    expect(sessionsRes.body.sessions[0].sessionId).toBe('sid-carol');
  });

  it('allows an admin to access any community', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .get(`/api/communities/${community._id}/sessions`)
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(200);
  });
});
