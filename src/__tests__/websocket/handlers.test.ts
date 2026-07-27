import { WebSocket } from 'ws';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { User } from '../../models/User';
import { ArchivedSession } from '../../models/ArchivedSession';
import { Community } from '../../models/Community';
import { makeSessionData } from '../fixtures';
import * as sessionManager from '../../websocket/sessionManager';
import { handleMessage } from '../../websocket/handlers';

// Prevent actual Discord calls
jest.mock('../../services/discordWebhook', () => ({
  enqueueWebhookNotification: jest.fn(),
  upsertArchivedSessionNotification: jest.fn().mockResolvedValue('discord-msg-1'),
}));
jest.mock('../../services/discordGateway', () => ({
  updateActiveSessionsEmbed: jest.fn(),
}));

class MockWebSocket {
  public readyState = WebSocket.OPEN;
  public sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  lastMessage() {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
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

describe('WebSocket AUTH handler', () => {
  it('AUTH_FAILURE when username or token missing', async () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleMessage(ws, JSON.stringify({ type: 'AUTH', username: '', token: '' }));
    const msg = (ws as unknown as MockWebSocket).lastMessage();
    expect(msg.type).toBe('AUTH_FAILURE');
  });

  it('creates new user and returns AUTH_SUCCESS with setup link', async () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleMessage(ws, JSON.stringify({ type: 'AUTH', username: 'NewPlayer', token: 'uuid-123' }));
    const msg = (ws as unknown as MockWebSocket).lastMessage();
    expect(msg.type).toBe('AUTH_SUCCESS');
    expect(msg.setupRequired).toBe(true);
    expect(msg.setupLink).toBeDefined();

    const user = await User.findOne({ username: 'NewPlayer' });
    expect(user).not.toBeNull();
    expect(user!.token).toBe('uuid-123');
  });

  it('AUTH_FAILURE for existing user with wrong token', async () => {
    await User.create({
      username: 'Existing',
      passwordHash: 'hash',
      token: 'correct-token',
      isAdmin: false,
      setupLinkUsed: false,
    });

    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleMessage(ws, JSON.stringify({ type: 'AUTH', username: 'Existing', token: 'wrong-token' }));
    const msg = (ws as unknown as MockWebSocket).lastMessage();
    expect(msg.type).toBe('AUTH_FAILURE');
  });

  it('AUTH_SUCCESS for existing user with correct token, no setup link if already set up', async () => {
    await User.create({
      username: 'Existing',
      passwordHash: 'hash',
      token: 'correct-token',
      isAdmin: false,
      setupLinkUsed: true,
    });

    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleMessage(ws, JSON.stringify({ type: 'AUTH', username: 'Existing', token: 'correct-token' }));
    const msg = (ws as unknown as MockWebSocket).lastMessage();
    expect(msg.type).toBe('AUTH_SUCCESS');
    expect(msg.setupRequired).toBe(false);
    expect(msg.setupLink).toBeUndefined();
  });
});

describe('WebSocket session lifecycle', () => {
  async function authenticatePlayer(username: string, token: string) {
    await User.create({
      username,
      passwordHash: 'hash',
      token,
      isAdmin: false,
      setupLinkUsed: true,
    });
    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleMessage(ws, JSON.stringify({ type: 'AUTH', username, token }));
    return ws;
  }

  it('rejects SESSION_START without prior AUTH', async () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData: makeSessionData() }));
    const msg = (ws as unknown as MockWebSocket).lastMessage();
    expect(msg.type).toBe('AUTH_FAILURE');
  });

  it('handles SESSION_START and stores session data', async () => {
    const ws = await authenticatePlayer('SplashKing', 'tok-1');
    const sessionData = makeSessionData({ playerName: 'SplashKing' });
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData }));

    const mock = ws as unknown as MockWebSocket;
    expect(mock.lastMessage().type).toBe('ACK');

    const state = sessionManager.get('SplashKing');
    expect(state?.sessionData).not.toBeNull();
    expect(state?.sessionData?.playerName).toBe('SplashKing');
  });

  it('handles SESSION_UPDATE and updates in-memory state', async () => {
    const ws = await authenticatePlayer('SplashKing', 'tok-1');
    const initial = makeSessionData({ playerName: 'SplashKing', spellsCast: 100 });
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData: initial }));

    const updated = makeSessionData({ playerName: 'SplashKing', spellsCast: 500 });
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_UPDATE', sessionData: updated }));

    const state = sessionManager.get('SplashKing');
    expect(state?.sessionData?.spellsCast).toBe(500);
  });

  it('handles SESSION_END, archives to DB, and clears the active session data', async () => {
    const ws = await authenticatePlayer('SplashKing', 'tok-1');
    const sessionData = makeSessionData({ playerName: 'SplashKing' });
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData }));
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_END', sessionData }));

    const mock = ws as unknown as MockWebSocket;
    expect(mock.lastMessage().type).toBe('ACK');

    // The connection stays authenticated (a resumed session may SESSION_START again on the
    // same socket without re-AUTHing), but there's no in-progress session anymore.
    expect(sessionManager.get('SplashKing')?.sessionData).toBeNull();

    // Should be archived in DB
    const archived = await ArchivedSession.findOne({ username: 'SplashKing' });
    expect(archived).not.toBeNull();
  });

  it('resumes a session on the same connection after SESSION_END without re-AUTH', async () => {
    const ws = await authenticatePlayer('SplashKing', 'tok-1');
    const sessionData = makeSessionData({ playerName: 'SplashKing' });
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData }));
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_END', sessionData }));

    // No AUTH re-sent here — mirrors the plugin resuming a session on a still-open socket.
    const resumed = makeSessionData({ playerName: 'SplashKing', spellsCast: 999 });
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData: resumed }));

    const mock = ws as unknown as MockWebSocket;
    expect(mock.lastMessage().type).toBe('ACK');
    expect(sessionManager.get('SplashKing')?.sessionData?.spellsCast).toBe(999);
  });

  it('merges a resumed session (same startTime, later endTime) into the existing archived record', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { upsertArchivedSessionNotification } = require('../../services/discordWebhook') as {
      upsertArchivedSessionNotification: jest.Mock;
    };
    upsertArchivedSessionNotification.mockClear();

    const ws = await authenticatePlayer('SplashKing', 'tok-1');
    const startTime = new Date(Date.now() - 3_600_000).toISOString();

    // Finalized early, e.g. on an inactivity timeout, with partial stats.
    const partial = makeSessionData({
      playerName: 'SplashKing',
      startTime,
      spellsCast: 50,
      logoutTime: new Date(Date.now() - 1_800_000).toISOString(),
    });
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData: partial }));
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_END', sessionData: partial }));

    // Resumed and finalized again later with the same startTime but more accumulated stats.
    const continued = makeSessionData({
      playerName: 'SplashKing',
      startTime,
      spellsCast: 200,
      logoutTime: new Date().toISOString(),
    });
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData: continued }));
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_END', sessionData: continued }));

    const allArchived = await ArchivedSession.find({ username: 'SplashKing' });
    expect(allArchived).toHaveLength(1);
    expect(allArchived[0].session.spellsCast).toBe(200);

    // Second archive call should have edited the first notification rather than posting a new one.
    expect(upsertArchivedSessionNotification).toHaveBeenCalledTimes(2);
    expect(upsertArchivedSessionNotification.mock.calls[1][3]).toBe('discord-msg-1');
  });

  describe('extra webhook notifications (community + personal)', () => {
    it('posts to a community history webhook (in addition to the site-wide one) when the splasher is a member', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { upsertArchivedSessionNotification } = require('../../services/discordWebhook') as {
        upsertArchivedSessionNotification: jest.Mock;
      };
      upsertArchivedSessionNotification.mockClear();
      upsertArchivedSessionNotification.mockResolvedValue('discord-msg-1');

      const ws = await authenticatePlayer('SplashKing', 'tok-1');
      const player = await User.findOne({ username: 'SplashKing' });
      const community = await Community.create({
        name: 'Splash Squad',
        ownerIds: [player!._id],
        memberUserIds: [player!._id],
        discordHistoryWebhookUrl: 'https://discord.com/api/webhooks/111/community-token',
      });

      const sessionData = makeSessionData({ playerName: 'SplashKing' });
      await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData }));
      await handleMessage(ws, JSON.stringify({ type: 'SESSION_END', sessionData }));

      // One call for the site-wide webhook, one for the community webhook.
      expect(upsertArchivedSessionNotification).toHaveBeenCalledTimes(2);
      const communityCall = upsertArchivedSessionNotification.mock.calls.find(
        (call) => call[0] === community.discordHistoryWebhookUrl,
      );
      expect(communityCall).toBeDefined();
      expect(communityCall![1]).toBe('SplashKing');
      expect(communityCall![3]).toBeUndefined(); // no existing message id yet

      const archived = await ArchivedSession.findOne({ username: 'SplashKing' });
      expect(archived!.extraDiscordMessageIds?.get(community._id.toString())).toBe('discord-msg-1');
    });

    it('edits the community message in place when a resumed session re-finalizes', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { upsertArchivedSessionNotification } = require('../../services/discordWebhook') as {
        upsertArchivedSessionNotification: jest.Mock;
      };

      const ws = await authenticatePlayer('SplashKing', 'tok-1');
      const player = await User.findOne({ username: 'SplashKing' });
      const community = await Community.create({
        name: 'Splash Squad',
        ownerIds: [player!._id],
        memberUserIds: [player!._id],
        discordHistoryWebhookUrl: 'https://discord.com/api/webhooks/111/community-token',
      });

      const startTime = new Date(Date.now() - 3_600_000).toISOString();
      const partial = makeSessionData({
        playerName: 'SplashKing',
        startTime,
        spellsCast: 50,
        logoutTime: new Date(Date.now() - 1_800_000).toISOString(),
      });
      await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData: partial }));
      await handleMessage(ws, JSON.stringify({ type: 'SESSION_END', sessionData: partial }));

      upsertArchivedSessionNotification.mockClear();
      upsertArchivedSessionNotification.mockResolvedValue('discord-msg-2');

      const continued = makeSessionData({
        playerName: 'SplashKing',
        startTime,
        spellsCast: 200,
        logoutTime: new Date().toISOString(),
      });
      await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData: continued }));
      await handleMessage(ws, JSON.stringify({ type: 'SESSION_END', sessionData: continued }));

      const communityCall = upsertArchivedSessionNotification.mock.calls.find(
        (call) => call[0] === community.discordHistoryWebhookUrl,
      );
      expect(communityCall).toBeDefined();
      expect(communityCall![3]).toBe('discord-msg-1'); // edits the message from the first finalization
    });

    it('does not call the webhook for a community the splasher does not belong to', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { upsertArchivedSessionNotification } = require('../../services/discordWebhook') as {
        upsertArchivedSessionNotification: jest.Mock;
      };
      upsertArchivedSessionNotification.mockClear();
      upsertArchivedSessionNotification.mockResolvedValue('discord-msg-1');

      const ws = await authenticatePlayer('SplashKing', 'tok-1');
      const otherOwner = await User.create({
        username: 'OtherOwner',
        passwordHash: 'hash',
        token: 'other-token',
        isAdmin: false,
        setupLinkUsed: true,
      });
      await Community.create({
        name: 'Someone Else\'s Community',
        ownerIds: [otherOwner._id],
        memberUserIds: [],
        discordHistoryWebhookUrl: 'https://discord.com/api/webhooks/222/other-token',
      });

      const sessionData = makeSessionData({ playerName: 'SplashKing' });
      await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData }));
      await handleMessage(ws, JSON.stringify({ type: 'SESSION_END', sessionData }));

      // Only the site-wide webhook call — the splasher isn't a member of that community.
      expect(upsertArchivedSessionNotification).toHaveBeenCalledTimes(1);
    });

    it('posts to the splasher\'s own personal history webhook, additively with the community one', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { upsertArchivedSessionNotification } = require('../../services/discordWebhook') as {
        upsertArchivedSessionNotification: jest.Mock;
      };
      upsertArchivedSessionNotification.mockClear();
      upsertArchivedSessionNotification.mockResolvedValue('discord-msg-1');

      const ws = await authenticatePlayer('SplashKing', 'tok-1');
      await User.findOneAndUpdate(
        { username: 'SplashKing' },
        { discordHistoryWebhookUrl: 'https://discord.com/api/webhooks/333/personal-token' },
      );

      const sessionData = makeSessionData({ playerName: 'SplashKing' });
      await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData }));
      await handleMessage(ws, JSON.stringify({ type: 'SESSION_END', sessionData }));

      // Site-wide + personal, no community involved here.
      expect(upsertArchivedSessionNotification).toHaveBeenCalledTimes(2);
      const personalCall = upsertArchivedSessionNotification.mock.calls.find(
        (call) => call[0] === 'https://discord.com/api/webhooks/333/personal-token',
      );
      expect(personalCall).toBeDefined();

      const archived = await ArchivedSession.findOne({ username: 'SplashKing' });
      expect(archived!.extraDiscordMessageIds?.get('self')).toBe('discord-msg-1');
    });
  });

  it('sends AUTH_FAILURE for invalid JSON', async () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleMessage(ws, 'not-json{{{');
    const msg = (ws as unknown as MockWebSocket).lastMessage();
    expect(msg.type).toBe('AUTH_FAILURE');
  });
});
