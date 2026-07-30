import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';
import { Community } from '../../models/Community';
import { DiscordServerConfig } from '../../models/DiscordServerConfig';
import { SplasherApplication } from '../../models/SplasherApplication';
import { SecurityEvent } from '../../models/SecurityEvent';

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

describe('POST /api/community-bot/verify-setup', () => {
  it('logs a SecurityEvent and 404s for an unknown community name', async () => {
    const res = await request(app).post('/api/community-bot/verify-setup').send({
      communityName: 'Does Not Exist',
      apiToken: 'whatever',
      guildId: 'guild-1',
      discordUserId: 'user-1',
    });
    expect(res.status).toBe(404);

    const events = await SecurityEvent.find({});
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('setup-unknown-community');
  });

  it('logs a SecurityEvent and 403s when the token does not match the named community', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app).post('/api/community-bot/verify-setup').send({
      communityName: community.name,
      apiToken: 'wrong-token',
      guildId: 'guild-1',
      discordUserId: 'user-1',
    });
    expect(res.status).toBe(403);

    const events = await SecurityEvent.find({});
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('setup-token-mismatch');
    expect(events[0].communityId?.toString()).toBe(community._id.toString());
  });

  it('resolves the community id/name on a matching name + token, without logging anything', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app).post('/api/community-bot/verify-setup').send({
      communityName: 'alice community', // case-insensitive
      apiToken: community.apiToken,
      guildId: 'guild-1',
      discordUserId: 'user-1',
    });
    expect(res.status).toBe(200);
    expect(res.body.communityId).toBe(community._id.toString());

    expect(await SecurityEvent.countDocuments({})).toBe(0);
  });
});

describe('requireCommunityToken', () => {
  it('rejects requests with no or an invalid token', async () => {
    const noHeader = await request(app).get('/api/community-bot/discord-config');
    expect(noHeader.status).toBe(401);

    const badHeader = await request(app)
      .get('/api/community-bot/discord-config')
      .set('X-Community-Token', 'not-a-real-token');
    expect(badHeader.status).toBe(401);
  });
});

describe('community-bot data isolation', () => {
  it("community A's token cannot resolve community B's application", async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const bob = await createUser('bob', { communityEligible: true });
    const carol = await createUser('carol');
    const communityA = await Community.create({ name: 'A', ownerIds: [alice._id], memberUserIds: [] });
    const communityB = await Community.create({ name: 'B', ownerIds: [bob._id], memberUserIds: [] });

    const application = await SplasherApplication.create({
      communityId: communityB._id,
      userId: carol._id,
      source: 'website',
      status: 'pending',
    });

    const res = await request(app)
      .post(`/api/community-bot/applications/${application._id}/resolve`)
      .set('X-Community-Token', communityA.apiToken)
      .send({ approve: true });
    expect(res.status).toBe(404);

    const reloaded = await SplasherApplication.findById(application._id);
    expect(reloaded!.status).toBe('pending');
  });

  it("community A's token cannot read or overwrite community B's discord-config", async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const bob = await createUser('bob', { communityEligible: true });
    const communityA = await Community.create({ name: 'A', ownerIds: [alice._id], memberUserIds: [] });
    const communityB = await Community.create({ name: 'B', ownerIds: [bob._id], memberUserIds: [] });

    await request(app)
      .put('/api/community-bot/discord-config')
      .set('X-Community-Token', communityB.apiToken)
      .send({ guildId: 'guild-b', autoAddSplashers: true });

    // Using A's token, and even trying to smuggle B's community id in the body, must only
    // ever touch A's own config.
    await request(app)
      .put('/api/community-bot/discord-config')
      .set('X-Community-Token', communityA.apiToken)
      .send({ guildId: 'guild-a', communityId: communityB._id.toString(), autoAddSplashers: false });

    const configA = await DiscordServerConfig.findOne({ communityId: communityA._id });
    const configB = await DiscordServerConfig.findOne({ communityId: communityB._id });
    expect(configA!.guildId).toBe('guild-a');
    expect(configB!.guildId).toBe('guild-b');
    expect(configB!.autoAddSplashers).toBe(true);
  });
});

describe('POST /api/community-bot/link-account', () => {
  it('returns no-match for an incorrect token/rsn pair', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .post('/api/community-bot/link-account')
      .set('X-Community-Token', community.apiToken)
      .send({ token: 'bogus', rsn: 'nobody' });
    expect(res.body).toEqual({ matched: false, status: 'no-match' });
  });

  it('auto-adds when the discord config has autoAddSplashers on', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const carol = await createUser('carol');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });
    await DiscordServerConfig.create({ communityId: community._id, guildId: 'g1', autoAddSplashers: true });

    const res = await request(app)
      .post('/api/community-bot/link-account')
      .set('X-Community-Token', community.apiToken)
      .send({ token: carol.token, rsn: carol.username });
    expect(res.body.status).toBe('added');

    const updated = await Community.findById(community._id);
    expect(updated!.memberUserIds.map((id) => id.toString())).toContain(carol._id.toString());
  });

  it('leaves a pending application when staff approval is required', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const carol = await createUser('carol');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });
    await DiscordServerConfig.create({ communityId: community._id, guildId: 'g1', autoAddSplashers: false });

    const res = await request(app)
      .post('/api/community-bot/link-account')
      .set('X-Community-Token', community.apiToken)
      .send({ token: carol.token, rsn: carol.username });
    expect(res.body.status).toBe('pending');

    const updated = await Community.findById(community._id);
    expect(updated!.memberUserIds).toHaveLength(0);
    const applications = await SplasherApplication.find({ communityId: community._id });
    expect(applications).toHaveLength(1);
    expect(applications[0].status).toBe('pending');
  });
});
