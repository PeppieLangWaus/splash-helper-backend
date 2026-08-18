import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';
import { Community } from '../../models/Community';
import { ArchivedSession } from '../../models/ArchivedSession';
import { DiscordServerConfig } from '../../models/DiscordServerConfig';
import { ChatChannelName } from '../../models/ChatChannelName';
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
    // requireAuth (see middleware/auth.ts) now checks tokenVersion against a real User document,
    // so the token's subject has to actually exist — not just claim isAdmin in the payload.
    await createUser('admin', { isAdmin: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .get(`/api/communities/${community._id}/sessions`)
      .set('Authorization', `Bearer ${makeToken('admin', true)}`);
    expect(res.status).toBe(200);
  });
});

const VALID_WEBHOOK_1 = 'https://discord.com/api/webhooks/123456789/abcDEF-123';
const VALID_WEBHOOK_2 = 'https://discord.com/api/webhooks/987654321/xyz-789';

describe('PUT /api/communities/:communityId/webhook', () => {
  it('denies access to a non-owner, non-admin user', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    await createUser('mallory');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .put(`/api/communities/${community._id}/webhook`)
      .set('Authorization', `Bearer ${makeToken('mallory')}`)
      .send({ activeWebhookUrl: VALID_WEBHOOK_1 });
    expect(res.status).toBe(403);
  });

  it('returns 404 for a non-existent community', async () => {
    await createUser('alice', { communityEligible: true });
    const res = await request(app)
      .put('/api/communities/64b000000000000000000000/webhook')
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ activeWebhookUrl: VALID_WEBHOOK_1 });
    expect(res.status).toBe(404);
  });

  it('rejects a URL that is not a Discord webhook URL', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .put(`/api/communities/${community._id}/webhook`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ activeWebhookUrl: 'https://evil.example.com/steal-tokens' });
    expect(res.status).toBe(400);

    const reloaded = await Community.findById(community._id).lean();
    expect(reloaded!.discordActiveWebhookUrl).toBeUndefined();
  });

  it('sets the active and history webhooks independently', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .put(`/api/communities/${community._id}/webhook`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ activeWebhookUrl: VALID_WEBHOOK_1, historyWebhookUrl: VALID_WEBHOOK_2 });
    expect(res.status).toBe(200);
    expect(res.body.community.discordActiveWebhookUrl).toBe(VALID_WEBHOOK_1);
    expect(res.body.community.discordHistoryWebhookUrl).toBe(VALID_WEBHOOK_2);

    const reloaded = await Community.findById(community._id).lean();
    expect(reloaded!.discordActiveWebhookUrl).toBe(VALID_WEBHOOK_1);
    expect(reloaded!.discordHistoryWebhookUrl).toBe(VALID_WEBHOOK_2);
  });

  it('leaves a field unchanged when it is omitted from the body', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({
      name: 'Alice Community',
      ownerIds: [alice._id],
      memberUserIds: [],
      discordActiveWebhookUrl: VALID_WEBHOOK_1,
      discordHistoryWebhookUrl: VALID_WEBHOOK_2,
    });

    const res = await request(app)
      .put(`/api/communities/${community._id}/webhook`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ historyWebhookUrl: '' }); // clear history only, leave active untouched
    expect(res.status).toBe(200);
    expect(res.body.community.discordActiveWebhookUrl).toBe(VALID_WEBHOOK_1);
    expect(res.body.community.discordHistoryWebhookUrl).toBeUndefined();
  });

  it('clears the webhook URL when given an empty value', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({
      name: 'Alice Community',
      ownerIds: [alice._id],
      memberUserIds: [],
      discordActiveWebhookUrl: VALID_WEBHOOK_1,
    });

    const res = await request(app)
      .put(`/api/communities/${community._id}/webhook`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ activeWebhookUrl: '' });
    expect(res.status).toBe(200);

    const reloaded = await Community.findById(community._id).lean();
    expect(reloaded!.discordActiveWebhookUrl).toBeUndefined();
  });

  it('allows an admin to set the webhook for a community they do not own', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    await createUser('admin', { isAdmin: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .put(`/api/communities/${community._id}/webhook`)
      .set('Authorization', `Bearer ${makeToken('admin', true)}`)
      .send({ activeWebhookUrl: VALID_WEBHOOK_2 });
    expect(res.status).toBe(200);
    expect(res.body.community.discordActiveWebhookUrl).toBe(VALID_WEBHOOK_2);
  });
});

describe('PUT /api/communities/:communityId/members/:username/webhook', () => {
  it('denies access to a non-owner, non-admin user', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const carol = await createUser('carol');
    await createUser('mallory');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [carol._id] });

    const res = await request(app)
      .put(`/api/communities/${community._id}/members/carol/webhook`)
      .set('Authorization', `Bearer ${makeToken('mallory')}`)
      .send({ activeWebhookUrl: VALID_WEBHOOK_1 });
    expect(res.status).toBe(403);
  });

  it('returns 404 when the target user is not a member of the community', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    await createUser('carol');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .put(`/api/communities/${community._id}/members/carol/webhook`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ activeWebhookUrl: VALID_WEBHOOK_1 });
    expect(res.status).toBe(404);
  });

  it('sets a personal webhook override on the member\'s own User record', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const carol = await createUser('carol');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [carol._id] });

    const res = await request(app)
      .put(`/api/communities/${community._id}/members/carol/webhook`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ activeWebhookUrl: VALID_WEBHOOK_1, historyWebhookUrl: VALID_WEBHOOK_2 });
    expect(res.status).toBe(200);
    expect(res.body.discordActiveWebhookUrl).toBe(VALID_WEBHOOK_1);
    expect(res.body.discordHistoryWebhookUrl).toBe(VALID_WEBHOOK_2);

    const reloaded = await User.findById(carol._id).lean();
    expect(reloaded!.discordActiveWebhookUrl).toBe(VALID_WEBHOOK_1);
    expect(reloaded!.discordHistoryWebhookUrl).toBe(VALID_WEBHOOK_2);
  });
});

describe('POST /api/communities/:communityId/apply', () => {
  it('leaves a pending application when the community has no auto-add config', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    await createUser('carol');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .post(`/api/communities/${community._id}/apply`)
      .set('Authorization', `Bearer ${makeToken('carol')}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');

    const reloaded = await Community.findById(community._id);
    expect(reloaded!.memberUserIds).toHaveLength(0);
  });

  it('adds immediately when the community has autoAddSplashers on', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    await createUser('carol');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });
    await DiscordServerConfig.create({ communityId: community._id, guildId: 'g1', autoAddSplashers: true });

    const res = await request(app)
      .post(`/api/communities/${community._id}/apply`)
      .set('Authorization', `Bearer ${makeToken('carol')}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('added');

    const reloaded = await Community.findById(community._id);
    expect(reloaded!.memberUserIds).toHaveLength(1);
  });

  it('rejects a duplicate application while one is already pending', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    await createUser('carol');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    await request(app).post(`/api/communities/${community._id}/apply`).set('Authorization', `Bearer ${makeToken('carol')}`);
    const second = await request(app)
      .post(`/api/communities/${community._id}/apply`)
      .set('Authorization', `Bearer ${makeToken('carol')}`);
    expect(second.status).toBe(400);
  });
});

describe('POST /api/communities/:communityId/api-token/regenerate', () => {
  it('rotates the token, invalidating the old value', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });
    const oldToken = community.apiToken;

    const res = await request(app)
      .post(`/api/communities/${community._id}/api-token/regenerate`)
      .set('Authorization', `Bearer ${makeToken('alice')}`);
    expect(res.status).toBe(200);
    expect(res.body.apiToken).not.toBe(oldToken);

    const reloaded = await Community.findById(community._id);
    expect(reloaded!.apiToken).toBe(res.body.apiToken);
  });

  it('denies non-owners', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    await createUser('mallory');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .post(`/api/communities/${community._id}/api-token/regenerate`)
      .set('Authorization', `Bearer ${makeToken('mallory')}`);
    expect(res.status).toBe(403);
  });
});

const SNOWFLAKE_1 = '111111111111111111';
const SNOWFLAKE_2 = '222222222222222222';

describe('GET and PUT /api/communities/:communityId/discord-config', () => {
  it('denies access to a non-owner, non-admin user', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    await createUser('mallory');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const getRes = await request(app)
      .get(`/api/communities/${community._id}/discord-config`)
      .set('Authorization', `Bearer ${makeToken('mallory')}`);
    expect(getRes.status).toBe(403);

    const putRes = await request(app)
      .put(`/api/communities/${community._id}/discord-config`)
      .set('Authorization', `Bearer ${makeToken('mallory')}`)
      .send({ minPayoutGp: 5_000_000 });
    expect(putRes.status).toBe(403);
  });

  it('returns a null config before /setup has been run', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .get(`/api/communities/${community._id}/discord-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`);
    expect(res.status).toBe(200);
    expect(res.body.config).toBeNull();
  });

  it('returns 404 on PUT before /setup has been run', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .put(`/api/communities/${community._id}/discord-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ minPayoutGp: 5_000_000 });
    expect(res.status).toBe(404);
  });

  it('rejects channel/role ids that are not valid snowflakes', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });
    await DiscordServerConfig.create({ communityId: community._id, guildId: 'g1' });

    const res = await request(app)
      .put(`/api/communities/${community._id}/discord-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ bankChannelId: 'not-a-snowflake' });
    expect(res.status).toBe(400);
  });

  it('rejects a negative minPayoutGp', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });
    await DiscordServerConfig.create({ communityId: community._id, guildId: 'g1' });

    const res = await request(app)
      .put(`/api/communities/${community._id}/discord-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ minPayoutGp: -1 });
    expect(res.status).toBe(400);
  });

  it('updates the fields present in the body and leaves the rest unchanged', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });
    await DiscordServerConfig.create({
      communityId: community._id,
      guildId: 'g1',
      bankChannelId: SNOWFLAKE_1,
      supportRoleIds: [SNOWFLAKE_1],
      autoAddSplashers: false,
      minPayoutGp: 10_000_000,
    });

    const res = await request(app)
      .put(`/api/communities/${community._id}/discord-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ minPayoutGp: 5_000_000, autoAddSplashers: true, supportRoleIds: [SNOWFLAKE_1, SNOWFLAKE_2] });
    expect(res.status).toBe(200);
    expect(res.body.config.minPayoutGp).toBe(5_000_000);
    expect(res.body.config.autoAddSplashers).toBe(true);
    expect(res.body.config.supportRoleIds).toEqual([SNOWFLAKE_1, SNOWFLAKE_2]);
    expect(res.body.config.bankChannelId).toBe(SNOWFLAKE_1); // untouched

    const reloaded = await DiscordServerConfig.findOne({ communityId: community._id }).lean();
    expect(reloaded!.bankChannelId).toBe(SNOWFLAKE_1);
    expect(reloaded!.guildId).toBe('g1'); // never touched by this route
  });

  it('clears a channel id field when given an empty string', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });
    await DiscordServerConfig.create({ communityId: community._id, guildId: 'g1', bankChannelId: SNOWFLAKE_1 });

    const res = await request(app)
      .put(`/api/communities/${community._id}/discord-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ bankChannelId: '' });
    expect(res.status).toBe(200);
    expect(res.body.config.bankChannelId).toBeUndefined();
  });
});

describe('PUT /api/communities/:communityId/discord-invite', () => {
  it('sets and clears the invite URL, rejecting invalid values', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const invalid = await request(app)
      .put(`/api/communities/${community._id}/discord-invite`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ discordInviteUrl: 'https://example.com/not-an-invite' });
    expect(invalid.status).toBe(400);

    const set = await request(app)
      .put(`/api/communities/${community._id}/discord-invite`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ discordInviteUrl: 'https://discord.gg/abc123' });
    expect(set.status).toBe(200);
    expect(set.body.community.discordInviteUrl).toBe('https://discord.gg/abc123');

    const cleared = await request(app)
      .put(`/api/communities/${community._id}/discord-invite`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ discordInviteUrl: '' });
    expect(cleared.body.community.discordInviteUrl).toBeUndefined();
  });
});

describe('GET and PUT /api/communities/:communityId/chat-config', () => {
  it('denies access to a non-owner, non-admin user', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    await createUser('mallory');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .get(`/api/communities/${community._id}/chat-config`)
      .set('Authorization', `Bearer ${makeToken('mallory')}`);
    expect(res.status).toBe(403);
  });

  it('returns nulls when nothing is configured yet', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .get(`/api/communities/${community._id}/chat-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      friendsChatName: null,
      friendsChatDisplayName: null,
      clanChatName: null,
      discordFriendsChatWebhookUrl: null,
      discordClanChatWebhookUrl: null,
    });
  });

  it('sets Friends/Clan Chat names, the FC display name, and both chat webhooks', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .put(`/api/communities/${community._id}/chat-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({
        friendsChatName: 'Ardy Splash',
        friendsChatDisplayName: 'Ardy Splashers',
        clanChatName: 'Ardy Splash CC',
        discordFriendsChatWebhookUrl: VALID_WEBHOOK_1,
        discordClanChatWebhookUrl: VALID_WEBHOOK_2,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      friendsChatName: 'Ardy Splash',
      friendsChatDisplayName: 'Ardy Splashers',
      clanChatName: 'Ardy Splash CC',
      discordFriendsChatWebhookUrl: VALID_WEBHOOK_1,
      discordClanChatWebhookUrl: VALID_WEBHOOK_2,
    });

    const names = await ChatChannelName.find({ communityId: community._id }).lean();
    expect(names).toHaveLength(2);
  });

  it('rejects a Friends/Clan Chat name already registered to a different community', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const bob = await createUser('bob', { communityEligible: true });
    const communityA = await Community.create({ name: 'A', ownerIds: [alice._id], memberUserIds: [] });
    const communityB = await Community.create({ name: 'B', ownerIds: [bob._id], memberUserIds: [] });

    await request(app)
      .put(`/api/communities/${communityA._id}/chat-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ friendsChatName: 'Shared Name' })
      .expect(200);

    const res = await request(app)
      .put(`/api/communities/${communityB._id}/chat-config`)
      .set('Authorization', `Bearer ${makeToken('bob')}`)
      .send({ friendsChatName: 'Shared Name' });
    expect(res.status).toBe(409);

    const namesForB = await ChatChannelName.find({ communityId: communityB._id }).lean();
    expect(namesForB).toHaveLength(0);
  });

  it('allows the same name to be used as both a Friends Chat and a Clan Chat name', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const bob = await createUser('bob', { communityEligible: true });
    const communityA = await Community.create({ name: 'A', ownerIds: [alice._id], memberUserIds: [] });
    const communityB = await Community.create({ name: 'B', ownerIds: [bob._id], memberUserIds: [] });

    // Same community, same name, both channel types.
    const sameRes = await request(app)
      .put(`/api/communities/${communityA._id}/chat-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ friendsChatName: 'Ardy Splash', clanChatName: 'Ardy Splash' });
    expect(sameRes.status).toBe(200);
    expect(sameRes.body.friendsChatName).toBe('Ardy Splash');
    expect(sameRes.body.clanChatName).toBe('Ardy Splash');

    // A different community can also register that same name as the other channel type.
    const otherRes = await request(app)
      .put(`/api/communities/${communityB._id}/chat-config`)
      .set('Authorization', `Bearer ${makeToken('bob')}`)
      .send({ clanChatName: 'Ardy Splash 2' })
      .expect(200);
    expect(otherRes.body.clanChatName).toBe('Ardy Splash 2');
  });

  it('allows re-saving the same name for the community that already owns it', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    await request(app)
      .put(`/api/communities/${community._id}/chat-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ friendsChatName: 'Ardy Splash' })
      .expect(200);

    const res = await request(app)
      .put(`/api/communities/${community._id}/chat-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ friendsChatName: 'Ardy Splash', clanChatName: 'Ardy CC' });
    expect(res.status).toBe(200);
    expect(res.body.friendsChatName).toBe('Ardy Splash');
    expect(res.body.clanChatName).toBe('Ardy CC');
  });

  it('rejects an invalid Discord webhook URL', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .put(`/api/communities/${community._id}/chat-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ discordFriendsChatWebhookUrl: 'not-a-webhook' });
    expect(res.status).toBe(400);
  });

  it('clears a Friends Chat name when set to an empty string', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    await request(app)
      .put(`/api/communities/${community._id}/chat-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ friendsChatName: 'Ardy Splash' })
      .expect(200);

    const res = await request(app)
      .put(`/api/communities/${community._id}/chat-config`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ friendsChatName: '' });
    expect(res.status).toBe(200);
    expect(res.body.friendsChatName).toBeNull();

    const doc = await ChatChannelName.findOne({ communityId: community._id, channelType: 'fc' }).lean();
    expect(doc).toBeNull();
  });
});

describe('Chat source block-list (/chat-sources)', () => {
  it('denies access to a non-owner, non-admin user', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    await createUser('mallory');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .get(`/api/communities/${community._id}/chat-sources`)
      .set('Authorization', `Bearer ${makeToken('mallory')}`);
    expect(res.status).toBe(403);
  });

  it('blocks a source by IP and lists it', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const block = await request(app)
      .post(`/api/communities/${community._id}/chat-sources/block`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ ip: '9.9.9.9' });
    expect(block.status).toBe(201);
    expect(block.body.blockedChatSources).toHaveLength(1);
    expect(block.body.blockedChatSources[0].ip).toBe('9.9.9.9');

    const list = await request(app)
      .get(`/api/communities/${community._id}/chat-sources`)
      .set('Authorization', `Bearer ${makeToken('alice')}`);
    expect(list.body.blocked).toHaveLength(1);
    expect(list.body.recent).toEqual([]);
  });

  it('requires ip or playerName to block', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    const res = await request(app)
      .post(`/api/communities/${community._id}/chat-sources/block`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('unblocks a source by playerName, case-insensitively', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });

    await request(app)
      .post(`/api/communities/${community._id}/chat-sources/block`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ playerName: 'Griefer' })
      .expect(201);

    const unblock = await request(app)
      .delete(`/api/communities/${community._id}/chat-sources/block`)
      .set('Authorization', `Bearer ${makeToken('alice')}`)
      .send({ playerName: 'griefer' });
    expect(unblock.status).toBe(200);
    expect(unblock.body.blockedChatSources).toEqual([]);
  });
});
