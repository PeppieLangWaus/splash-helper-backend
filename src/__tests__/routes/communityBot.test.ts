import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { Types } from 'mongoose';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';
import { Community } from '../../models/Community';
import { DiscordServerConfig } from '../../models/DiscordServerConfig';
import { SplasherApplication } from '../../models/SplasherApplication';
import { SecurityEvent } from '../../models/SecurityEvent';
import { ArchivedSession } from '../../models/ArchivedSession';
import { BankTicket } from '../../models/BankTicket';
import * as sessionManager from '../../websocket/sessionManager';
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
  sessionManager.getAll().forEach((s) => sessionManager.remove(s.username));
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

describe('GET /api/community-bot/active-sessions', () => {
  it('only returns active sessions belonging to community members', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const member = await createUser('member');
    const nonMember = await createUser('nonMember');
    const community = await Community.create({
      name: 'Alice Community',
      ownerIds: [alice._id],
      memberUserIds: [member._id],
    });

    const ws = {} as unknown as WebSocket;
    const memberState = sessionManager.createInitialState(member.username, ws, member._id.toString());
    memberState.authenticated = true;
    memberState.sessionData = makeSessionData({ playerName: member.username, world: 305 });
    sessionManager.set(member.username, memberState);

    const nonMemberState = sessionManager.createInitialState(nonMember.username, ws, nonMember._id.toString());
    nonMemberState.authenticated = true;
    nonMemberState.sessionData = makeSessionData({ playerName: nonMember.username, world: 306 });
    sessionManager.set(nonMember.username, nonMemberState);

    const res = await request(app)
      .get('/api/community-bot/active-sessions')
      .set('X-Community-Token', community.apiToken);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].username).toBe(member.username);
    expect(res.body.sessions[0].session.world).toBe(305);
  });

  it('excludes sessions that are not authenticated or have no session data yet', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const member = await createUser('member');
    const community = await Community.create({
      name: 'Alice Community',
      ownerIds: [alice._id],
      memberUserIds: [member._id],
    });

    const ws = {} as unknown as WebSocket;
    const idleState = sessionManager.createInitialState(member.username, ws, member._id.toString());
    idleState.authenticated = true;
    idleState.sessionData = null;
    sessionManager.set(member.username, idleState);

    const res = await request(app)
      .get('/api/community-bot/active-sessions')
      .set('X-Community-Token', community.apiToken);
    expect(res.body.sessions).toHaveLength(0);
  });
});

describe('GET /api/community-bot/sessions/history', () => {
  it('only returns sessions belonging to community members, newest-last after `since`', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const member = await createUser('member');
    const nonMember = await createUser('nonMember');
    const community = await Community.create({
      name: 'Alice Community',
      ownerIds: [alice._id],
      memberUserIds: [member._id],
    });

    await ArchivedSession.create({
      sessionId: 'old-session',
      createdTimestamp: 1000,
      finalizedTimestamp: 2000,
      userId: member._id,
      username: member.username,
      session: makeSessionData({ playerName: member.username }),
    });
    await ArchivedSession.create({
      sessionId: 'new-session',
      createdTimestamp: 3000,
      finalizedTimestamp: 4000,
      userId: member._id,
      username: member.username,
      session: makeSessionData({ playerName: member.username }),
    });
    await ArchivedSession.create({
      sessionId: 'other-community-session',
      createdTimestamp: 3000,
      finalizedTimestamp: 4000,
      userId: nonMember._id,
      username: nonMember.username,
      session: makeSessionData({ playerName: nonMember.username }),
    });

    const res = await request(app)
      .get('/api/community-bot/sessions/history')
      .query({ since: 2000 })
      .set('X-Community-Token', community.apiToken);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].sessionId).toBe('new-session');
  });

  it('defaults to everything when `since` is omitted', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const member = await createUser('member');
    const community = await Community.create({
      name: 'Alice Community',
      ownerIds: [alice._id],
      memberUserIds: [member._id],
    });

    await ArchivedSession.create({
      sessionId: 'session-1',
      createdTimestamp: 1000,
      finalizedTimestamp: 2000,
      userId: member._id,
      username: member.username,
      session: makeSessionData({ playerName: member.username }),
    });

    const res = await request(app)
      .get('/api/community-bot/sessions/history')
      .set('X-Community-Token', community.apiToken);
    expect(res.body.sessions).toHaveLength(1);
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

  it('stores discordUserId on the matched user when a match is found', async () => {
    const alice = await createUser('alice', { communityEligible: true });
    const carol = await createUser('carol');
    const community = await Community.create({ name: 'Alice Community', ownerIds: [alice._id], memberUserIds: [] });
    await DiscordServerConfig.create({ communityId: community._id, guildId: 'g1', autoAddSplashers: false });

    await request(app)
      .post('/api/community-bot/link-account')
      .set('X-Community-Token', community.apiToken)
      .send({ token: carol.token, rsn: carol.username, discordUserId: 'discord-carol' });

    const updated = await User.findById(carol._id);
    expect(updated!.discordUserId).toBe('discord-carol');
  });
});

describe('income and bank routes', () => {
  let suffix = 0;

  async function setupCommunityWithSplasher(minPayoutGp?: number) {
    const id = suffix++;
    const owner = await createUser(`owner${id}`, { communityEligible: true });
    const splasher = await createUser(`splasher${id}`);
    splasher.discordUserId = 'discord-splasher';
    await splasher.save();
    const community = await Community.create({ name: `Community ${id}`, ownerIds: [owner._id], memberUserIds: [splasher._id] });
    await DiscordServerConfig.create({
      communityId: community._id,
      guildId: 'g1',
      ...(minPayoutGp !== undefined ? { minPayoutGp } : {}),
    });
    return { owner, splasher, community };
  }

  async function createEarnedSession(
    splasherId: Types.ObjectId,
    communityId: Types.ObjectId,
    hours: number,
    hourlyRate: number,
    id: string,
  ) {
    await ArchivedSession.create({
      sessionId: id,
      createdTimestamp: 0,
      finalizedTimestamp: hours * 3_600_000,
      userId: splasherId,
      username: 'splasher',
      session: makeSessionData({ playerName: 'splasher' }),
      earningsSnapshot: new Map([
        [communityId.toString(), { rankId: splasherId, rankName: 'Default', hourlyRate }],
      ]),
    });
  }

  describe('GET /api/community-bot/income', () => {
    it('returns linked:false for an unlinked discordUserId', async () => {
      const { community } = await setupCommunityWithSplasher();
      const res = await request(app)
        .get('/api/community-bot/income')
        .query({ discordUserId: 'someone-else' })
        .set('X-Community-Token', community.apiToken);
      expect(res.body).toEqual({ linked: false });
    });

    it('reports total earned, paid out, and available gp for a linked splasher', async () => {
      const { splasher, community } = await setupCommunityWithSplasher();
      await createEarnedSession(splasher._id, community._id, 10, 1000, 's1');
      await BankTicket.create({
        communityId: community._id,
        type: 'payout',
        amountGp: 4000,
        status: 'completed',
        requestedByUserId: splasher._id,
        requestedByUsername: splasher.username,
        requestedByDiscordId: 'discord-splasher',
      });

      const res = await request(app)
        .get('/api/community-bot/income')
        .query({ discordUserId: 'discord-splasher' })
        .set('X-Community-Token', community.apiToken);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        linked: true,
        username: splasher.username,
        totalEarnedGp: 10_000,
        totalPaidOutGp: 4_000,
        availableGp: 6_000,
      });
    });
  });

  describe('POST /api/community-bot/income/payout', () => {
    it('rejects a payout below the configured minimum', async () => {
      const { splasher, community } = await setupCommunityWithSplasher(10_000_000);
      await createEarnedSession(splasher._id, community._id, 10, 1000, 's1'); // only 10,000 gp earned

      const res = await request(app)
        .post('/api/community-bot/income/payout')
        .set('X-Community-Token', community.apiToken)
        .send({ discordUserId: 'discord-splasher' });
      expect(res.status).toBe(400);
      expect(res.body.availableGp).toBe(10_000);
      expect(res.body.minPayoutGp).toBe(10_000_000);

      expect(await BankTicket.countDocuments({ communityId: community._id })).toBe(0);
    });

    it('opens a pending payout ticket with the frozen available balance when eligible', async () => {
      const { splasher, community } = await setupCommunityWithSplasher(1_000);
      await createEarnedSession(splasher._id, community._id, 10, 1000, 's1'); // 10,000 gp earned

      const res = await request(app)
        .post('/api/community-bot/income/payout')
        .set('X-Community-Token', community.apiToken)
        .send({ discordUserId: 'discord-splasher' });
      expect(res.status).toBe(201);
      expect(res.body.ticket.type).toBe('payout');
      expect(res.body.ticket.amountGp).toBe(10_000);
      expect(res.body.ticket.status).toBe('pending');
      expect(res.body.ticket.requestedByUsername).toBe(splasher.username);
    });
  });

  describe('bank ticket lifecycle', () => {
    it('rejects a withdraw ticket that would overdraw the bank', async () => {
      const { community } = await setupCommunityWithSplasher();
      await Community.updateOne({ _id: community._id }, { bankGp: 500 });

      const res = await request(app)
        .post('/api/community-bot/bank/tickets')
        .set('X-Community-Token', community.apiToken)
        .send({ type: 'withdraw', amountGp: 1000, discordUserId: 'staff-1', discordUsername: 'StaffOne' });
      expect(res.status).toBe(400);
      expect(await BankTicket.countDocuments({ communityId: community._id })).toBe(0);
    });

    it('deposit resolution adds to the bank and requires a screenshot', async () => {
      const { community } = await setupCommunityWithSplasher();

      const createRes = await request(app)
        .post('/api/community-bot/bank/tickets')
        .set('X-Community-Token', community.apiToken)
        .send({ type: 'deposit', amountGp: 5000, discordUserId: 'staff-1', discordUsername: 'StaffOne' });
      expect(createRes.status).toBe(201);
      const ticketId = createRes.body.ticket._id;

      const noScreenshotRes = await request(app)
        .post(`/api/community-bot/bank/tickets/${ticketId}/resolve`)
        .set('X-Community-Token', community.apiToken)
        .send({ approve: true, authorizedByDiscordId: 'staff-1', authorizedByUsername: 'StaffOne' });
      expect(noScreenshotRes.status).toBe(400);

      const resolveRes = await request(app)
        .post(`/api/community-bot/bank/tickets/${ticketId}/resolve`)
        .set('X-Community-Token', community.apiToken)
        .send({
          approve: true,
          screenshotUrl: 'https://cdn.discordapp.com/attachments/1/2/proof.png',
          authorizedByDiscordId: 'staff-1',
          authorizedByUsername: 'StaffOne',
        });
      expect(resolveRes.status).toBe(200);
      expect(resolveRes.body.bankGp).toBe(5000);
      expect(resolveRes.body.ticket.status).toBe('completed');

      const updated = await Community.findById(community._id);
      expect(updated!.bankGp).toBe(5000);
    });

    it('withdraw/payout resolution subtracts from the bank, re-checked at resolve time', async () => {
      const { splasher, community } = await setupCommunityWithSplasher();
      await Community.updateOne({ _id: community._id }, { bankGp: 1000 });

      const ticket = await BankTicket.create({
        communityId: community._id,
        type: 'payout',
        amountGp: 1000,
        requestedByUserId: splasher._id,
        requestedByUsername: splasher.username,
        requestedByDiscordId: 'discord-splasher',
      });

      // Balance drops out from under the ticket after it was opened.
      await Community.updateOne({ _id: community._id }, { bankGp: 500 });

      const insufficientRes = await request(app)
        .post(`/api/community-bot/bank/tickets/${ticket._id}/resolve`)
        .set('X-Community-Token', community.apiToken)
        .send({
          approve: true,
          screenshotUrl: 'https://cdn.discordapp.com/attachments/1/2/proof.png',
          authorizedByDiscordId: 'staff-1',
          authorizedByUsername: 'StaffOne',
        });
      expect(insufficientRes.status).toBe(400);

      await Community.updateOne({ _id: community._id }, { bankGp: 2000 });
      const okRes = await request(app)
        .post(`/api/community-bot/bank/tickets/${ticket._id}/resolve`)
        .set('X-Community-Token', community.apiToken)
        .send({
          approve: true,
          screenshotUrl: 'https://cdn.discordapp.com/attachments/1/2/proof.png',
          authorizedByDiscordId: 'staff-1',
          authorizedByUsername: 'StaffOne',
        });
      expect(okRes.status).toBe(200);
      expect(okRes.body.bankGp).toBe(1000);
    });

    it('rejecting a ticket leaves the bank balance untouched', async () => {
      const { community } = await setupCommunityWithSplasher();
      await Community.updateOne({ _id: community._id }, { bankGp: 1000 });

      const createRes = await request(app)
        .post('/api/community-bot/bank/tickets')
        .set('X-Community-Token', community.apiToken)
        .send({ type: 'deposit', amountGp: 5000, discordUserId: 'staff-1', discordUsername: 'StaffOne' });

      const res = await request(app)
        .post(`/api/community-bot/bank/tickets/${createRes.body.ticket._id}/resolve`)
        .set('X-Community-Token', community.apiToken)
        .send({ approve: false, authorizedByDiscordId: 'staff-1', authorizedByUsername: 'StaffOne' });
      expect(res.status).toBe(200);
      expect(res.body.ticket.status).toBe('rejected');

      const updated = await Community.findById(community._id);
      expect(updated!.bankGp).toBe(1000);
    });

    it("community A's token cannot resolve community B's bank ticket", async () => {
      const { community: communityA } = await setupCommunityWithSplasher();
      const { community: communityB } = await setupCommunityWithSplasher();

      const createRes = await request(app)
        .post('/api/community-bot/bank/tickets')
        .set('X-Community-Token', communityB.apiToken)
        .send({ type: 'deposit', amountGp: 5000, discordUserId: 'staff-1', discordUsername: 'StaffOne' });

      const res = await request(app)
        .post(`/api/community-bot/bank/tickets/${createRes.body.ticket._id}/resolve`)
        .set('X-Community-Token', communityA.apiToken)
        .send({
          approve: true,
          screenshotUrl: 'https://cdn.discordapp.com/attachments/1/2/proof.png',
          authorizedByDiscordId: 'staff-1',
          authorizedByUsername: 'StaffOne',
        });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/community-bot/bank', () => {
    it('returns the community bank balance and minimum payout', async () => {
      const { community } = await setupCommunityWithSplasher(2_000_000);
      await Community.updateOne({ _id: community._id }, { bankGp: 42_000 });

      const res = await request(app)
        .get('/api/community-bot/bank')
        .set('X-Community-Token', community.apiToken);
      expect(res.body).toEqual({ bankGp: 42_000, minPayoutGp: 2_000_000 });
    });
  });
});
