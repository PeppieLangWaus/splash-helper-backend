import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';
import { Community } from '../../models/Community';
import { Rank } from '../../models/Rank';

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

/** `Community.create()` alone (used by most fixtures) skips the default-rank auto-creation
 *  that only happens in the real POST /api/communities handler — recreate that here so rank
 *  CRUD tests see the same starting state a real community would have. */
async function createCommunityWithDefaultRank(
  ownerIds: import('mongoose').Types.ObjectId[],
  memberUserIds: import('mongoose').Types.ObjectId[] = [],
  name = 'Alice Community',
) {
  const community = await Community.create({ name, ownerIds, memberUserIds });
  await Rank.create({ communityId: community._id, name: 'Default', hourlyRate: 0, isDefault: true });
  return community;
}

describe('Rank creation on community creation', () => {
  it('auto-creates a single default rank when a community is created', async () => {
    await createUser('alice', { communityEligible: true });
    const res = await request(app)
      .post('/api/communities')
      .set('Authorization', `Bearer ${makeToken('alice', false, true)}`)
      .send({ name: 'My Community' });

    const ranks = await Rank.find({ communityId: res.body.community._id });
    expect(ranks).toHaveLength(1);
    expect(ranks[0].isDefault).toBe(true);
    expect(ranks[0].name).toBe('Default');
  });
});

describe('Rank CRUD under /api/communities/:communityId/ranks', () => {
  it('denies non-owners', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    await createUser('mallory');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .post(`/api/communities/${community._id}/ranks`)
      .set('Authorization', `Bearer ${makeToken('mallory')}`)
      .send({ name: 'Veteran', hourlyRate: 5 });
    expect(res.status).toBe(403);
  });

  it('owner can create, edit, and delete a non-default rank', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await createCommunityWithDefaultRank([alice._id]);

    const create = await request(app)
      .post(`/api/communities/${community._id}/ranks`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ name: 'Veteran', hourlyRate: 5 });
    expect(create.status).toBe(201);
    const rankId = create.body.rank._id;

    const edit = await request(app)
      .put(`/api/communities/${community._id}/ranks/${rankId}`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ hourlyRate: 8 });
    expect(edit.status).toBe(200);
    expect(edit.body.rank.hourlyRate).toBe(8);

    const del = await request(app)
      .delete(`/api/communities/${community._id}/ranks/${rankId}`)
      .set('Authorization', `Bearer ${makeToken('alice')}`);
    expect(del.status).toBe(200);
    expect(await Rank.findById(rankId)).toBeNull();
  });

  it('refuses to delete the default rank', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await createCommunityWithDefaultRank([alice._id]);
    const defaultRank = await Rank.findOne({ communityId: community._id, isDefault: true });

    const res = await request(app)
      .delete(`/api/communities/${community._id}/ranks/${defaultRank!._id}`)
      .set('Authorization', `Bearer ${makeToken('alice')}`);
    expect(res.status).toBe(400);
  });

  it('refuses to delete a rank that still has members assigned', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const carol = await createUser('carol');
    const community = await createCommunityWithDefaultRank([alice._id], [carol._id]);

    const create = await request(app)
      .post(`/api/communities/${community._id}/ranks`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ name: 'Veteran', hourlyRate: 5 });
    const rankId = create.body.rank._id;

    await request(app)
      .put(`/api/communities/${community._id}/members/carol/rank`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ rankId });

    const del = await request(app)
      .delete(`/api/communities/${community._id}/ranks/${rankId}`)
      .set('Authorization', `Bearer ${makeToken('alice')}`);
    expect(del.status).toBe(400);
  });
});

describe('PUT /api/communities/:communityId/members/:username/rank', () => {
  it('assigns a member to a different rank, reflected in GET /splashers', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const carol = await createUser('carol');
    const community = await Community.create({
      name: 'Alice Community',
      ownerIds: [alice._id],
      memberUserIds: [carol._id],
    });

    const create = await request(app)
      .post(`/api/communities/${community._id}/ranks`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ name: 'Veteran', hourlyRate: 15 });
    const rankId = create.body.rank._id;

    const assign = await request(app)
      .put(`/api/communities/${community._id}/members/carol/rank`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ rankId });
    expect(assign.status).toBe(200);
    expect(assign.body.rank.hourlyRate).toBe(15);

    const list = await request(app)
      .get(`/api/communities/${community._id}/splashers`)
      .set('Authorization', `Bearer ${makeToken('alice')}`);
    const carolEntry = list.body.splashers.find((s: { username: string }) => s.username === 'carol');
    expect(carolEntry.rank.name).toBe('Veteran');
  });
});
