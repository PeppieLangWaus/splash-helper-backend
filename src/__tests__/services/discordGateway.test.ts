import { WebSocket } from 'ws';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { User } from '../../models/User';
import { Community } from '../../models/Community';
import { ActiveSessionState } from '../../types';
import { makeSessionData } from '../fixtures';

let mockSend: jest.Mock;
let mockEditMessage: jest.Mock;
let updateActiveSessionsEmbed: (sessions: ActiveSessionState[]) => void;

function makeActiveSession(userId: string, username: string): ActiveSessionState {
  return {
    ws: {} as WebSocket,
    username,
    userId,
    authenticated: true,
    sessionData: makeSessionData({ playerName: username }),
    lastUpdate: Date.now(),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// updateCommunityEmbeds() does a real (mongodb-memory-server) DB round trip before it
// gets to the webhook call, so a single setImmediate/microtask flush isn't enough to
// observe its effects — poll until the mock has been called the expected number of times.
async function waitForCalls(mock: jest.Mock, count: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (mock.mock.calls.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${count} call(s); got ${mock.mock.calls.length}`);
    }
    await wait(10);
  }
}

beforeAll(async () => {
  await connectTestDB();

  // No global site-wide webhook — isolates these tests to the per-community path.
  process.env.DISCORD_ACTIVE_WEBHOOK_URL = '';
  // Disables the community config cache so every call re-reads the DB (tests
  // don't have to fight a 15s TTL), and shrinks the edit-throttle window so a
  // short real-time wait between calls is enough to trigger a second send.
  process.env.DISCORD_COMMUNITY_CACHE_TTL_MS = '0';
  process.env.DISCORD_EMBED_UPDATE_INTERVAL_MS = '10';

  mockSend = jest.fn().mockResolvedValue({ id: 'active-msg-1' });
  mockEditMessage = jest.fn().mockResolvedValue({ id: 'active-msg-1' });

  jest.mock('discord.js', () => {
    class EmbedBuilder {
      data: Record<string, unknown> = { fields: [] as unknown[] };
      setTitle(t: string) { this.data.title = t; return this; }
      setColor(c: number) { this.data.color = c; return this; }
      setThumbnail(u: string) { this.data.thumbnail = u; return this; }
      addFields(...f: unknown[]) { (this.data.fields as unknown[]).push(...f); return this; }
      setFooter(f: unknown) { this.data.footer = f; return this; }
      setTimestamp(d?: Date) { this.data.timestamp = d; return this; }
    }
    return {
      WebhookClient: jest.fn().mockImplementation(() => ({ send: mockSend, editMessage: mockEditMessage })),
      EmbedBuilder,
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const gw = require('../../services/discordGateway') as typeof import('../../services/discordGateway');
  updateActiveSessionsEmbed = gw.updateActiveSessionsEmbed;
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
  mockSend.mockClear();
  mockEditMessage.mockClear();
});

describe('updateActiveSessionsEmbed — per-community webhooks', () => {
  it('does nothing when no community has a webhook configured', async () => {
    await User.create({ username: 'alice', passwordHash: 'h', token: 't1', isAdmin: false, setupLinkUsed: true });
    updateActiveSessionsEmbed([]);
    await wait(100);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('posts an embed scoped to a community\'s own members, excluding non-members', async () => {
    const alice = await User.create({ username: 'alice', passwordHash: 'h', token: 't1', isAdmin: false, setupLinkUsed: true });
    const bob = await User.create({ username: 'bob', passwordHash: 'h', token: 't2', isAdmin: false, setupLinkUsed: true });

    const community = await Community.create({
      name: 'Alice Squad',
      ownerIds: [alice._id],
      memberUserIds: [alice._id],
      discordActiveWebhookUrl: 'https://discord.com/api/webhooks/111/community-token',
    });

    const sessions = [
      makeActiveSession(alice._id.toString(), 'alice'),
      makeActiveSession(bob._id.toString(), 'bob'),
    ];

    updateActiveSessionsEmbed(sessions);
    await waitForCalls(mockSend, 1);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const body = mockSend.mock.calls[0][0] as { embeds: { data: Record<string, unknown> }[] };
    const embedData = body.embeds[0].data;
    expect(embedData.title).toBe(`Active Splashers — ${community.name}`);
    const fields = embedData.fields as { name: string }[];
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toContain('alice');
  });

  it('posts a separate embed per community, one webhook call each', async () => {
    const alice = await User.create({ username: 'alice', passwordHash: 'h', token: 't1', isAdmin: false, setupLinkUsed: true });
    const bob = await User.create({ username: 'bob', passwordHash: 'h', token: 't2', isAdmin: false, setupLinkUsed: true });

    await Community.create({
      name: 'Alice Squad',
      ownerIds: [alice._id],
      memberUserIds: [alice._id],
      discordActiveWebhookUrl: 'https://discord.com/api/webhooks/111/alice-token',
    });
    await Community.create({
      name: 'Bob Squad',
      ownerIds: [bob._id],
      memberUserIds: [bob._id],
      discordActiveWebhookUrl: 'https://discord.com/api/webhooks/222/bob-token',
    });

    const sessions = [
      makeActiveSession(alice._id.toString(), 'alice'),
      makeActiveSession(bob._id.toString(), 'bob'),
    ];

    updateActiveSessionsEmbed(sessions);
    await waitForCalls(mockSend, 2);

    expect(mockSend).toHaveBeenCalledTimes(2);
    const titles = mockSend.mock.calls.map((c) => (c[0] as { embeds: { data: Record<string, unknown> }[] }).embeds[0].data.title);
    expect(titles).toEqual(expect.arrayContaining(['Active Splashers — Alice Squad', 'Active Splashers — Bob Squad']));
  });

  it('edits the same message in place on a later update instead of posting a new one', async () => {
    const alice = await User.create({ username: 'alice', passwordHash: 'h', token: 't1', isAdmin: false, setupLinkUsed: true });
    await Community.create({
      name: 'Alice Squad',
      ownerIds: [alice._id],
      memberUserIds: [alice._id],
      discordActiveWebhookUrl: 'https://discord.com/api/webhooks/111/community-token',
    });

    const sessions = [makeActiveSession(alice._id.toString(), 'alice')];

    updateActiveSessionsEmbed(sessions);
    await waitForCalls(mockSend, 1);
    expect(mockSend).toHaveBeenCalledTimes(1);

    await wait(20); // clear the throttle window (DISCORD_EMBED_UPDATE_INTERVAL_MS=10)
    updateActiveSessionsEmbed(sessions);
    await waitForCalls(mockEditMessage, 1);

    expect(mockEditMessage).toHaveBeenCalledTimes(1);
    expect(mockEditMessage.mock.calls[0][0]).toBe('active-msg-1');
    expect(mockSend).toHaveBeenCalledTimes(1); // still just the one initial post
  });
});

describe('updateActiveSessionsEmbed — message id survives a restart', () => {
  // Each EmbedState is created fresh (activeMessageId starting out unknown) the first time
  // a given community/splasher id is seen, which is exactly what happens for every
  // config on a real process restart — so a community id that's brand new to this test
  // file exercises the same code path as "the backend just redeployed".
  it('edits a message from a previous process instead of posting a new one', async () => {
    const alice = await User.create({ username: 'alice', passwordHash: 'h', token: 't1', isAdmin: false, setupLinkUsed: true });
    const community = await Community.create({
      name: 'Restart Squad',
      ownerIds: [alice._id],
      memberUserIds: [alice._id],
      discordActiveWebhookUrl: 'https://discord.com/api/webhooks/555/restart-token',
    });
    const { DiscordEmbedMessage } = require('../../models/DiscordEmbedMessage') as typeof import('../../models/DiscordEmbedMessage');
    await DiscordEmbedMessage.create({
      key: `community:${community._id.toString()}`,
      webhookUrl: 'https://discord.com/api/webhooks/555/restart-token',
      messageId: 'message-from-before-restart',
    });

    updateActiveSessionsEmbed([makeActiveSession(alice._id.toString(), 'alice')]);
    await waitForCalls(mockEditMessage, 1);

    expect(mockEditMessage.mock.calls[0][0]).toBe('message-from-before-restart');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('persists a newly-posted message id so it can be reused after a restart', async () => {
    const alice = await User.create({ username: 'alice', passwordHash: 'h', token: 't1', isAdmin: false, setupLinkUsed: true });
    const community = await Community.create({
      name: 'Fresh Squad',
      ownerIds: [alice._id],
      memberUserIds: [alice._id],
      discordActiveWebhookUrl: 'https://discord.com/api/webhooks/666/fresh-token',
    });

    updateActiveSessionsEmbed([makeActiveSession(alice._id.toString(), 'alice')]);
    await waitForCalls(mockSend, 1);

    const { DiscordEmbedMessage } = require('../../models/DiscordEmbedMessage') as typeof import('../../models/DiscordEmbedMessage');
    const persisted = await DiscordEmbedMessage.findOne({ key: `community:${community._id.toString()}` }).lean();
    expect(persisted?.messageId).toBe('active-msg-1');
    expect(persisted?.webhookUrl).toBe('https://discord.com/api/webhooks/666/fresh-token');
  });

  it('ignores a persisted message id left over from a since-rotated webhook', async () => {
    const alice = await User.create({ username: 'alice', passwordHash: 'h', token: 't1', isAdmin: false, setupLinkUsed: true });
    const community = await Community.create({
      name: 'Rotated Squad',
      ownerIds: [alice._id],
      memberUserIds: [alice._id],
      discordActiveWebhookUrl: 'https://discord.com/api/webhooks/777/new-token',
    });
    const { DiscordEmbedMessage } = require('../../models/DiscordEmbedMessage') as typeof import('../../models/DiscordEmbedMessage');
    await DiscordEmbedMessage.create({
      key: `community:${community._id.toString()}`,
      webhookUrl: 'https://discord.com/api/webhooks/777/old-token',
      messageId: 'message-on-old-webhook',
    });

    updateActiveSessionsEmbed([makeActiveSession(alice._id.toString(), 'alice')]);
    await waitForCalls(mockSend, 1);

    expect(mockEditMessage).not.toHaveBeenCalled();
  });
});

describe('updateActiveSessionsEmbed — per-splasher webhooks', () => {
  it('posts a personal embed scoped to just that splasher\'s own session', async () => {
    const alice = await User.create({
      username: 'alice',
      passwordHash: 'h',
      token: 't1',
      isAdmin: false,
      setupLinkUsed: true,
      discordActiveWebhookUrl: 'https://discord.com/api/webhooks/444/alice-personal',
    });
    const bob = await User.create({ username: 'bob', passwordHash: 'h', token: 't2', isAdmin: false, setupLinkUsed: true });

    const sessions = [
      makeActiveSession(alice._id.toString(), 'alice'),
      makeActiveSession(bob._id.toString(), 'bob'),
    ];

    updateActiveSessionsEmbed(sessions);
    await waitForCalls(mockSend, 1);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const body = mockSend.mock.calls[0][0] as { embeds: { data: Record<string, unknown> }[] };
    const embedData = body.embeds[0].data;
    expect(embedData.title).toBe('Active Session — alice');
    const fields = embedData.fields as { name: string }[];
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toContain('alice');
  });

  it('posts both a community embed and the member\'s personal embed for the same splasher', async () => {
    const alice = await User.create({
      username: 'alice',
      passwordHash: 'h',
      token: 't1',
      isAdmin: false,
      setupLinkUsed: true,
      discordActiveWebhookUrl: 'https://discord.com/api/webhooks/444/alice-personal',
    });
    await Community.create({
      name: 'Alice Squad',
      ownerIds: [alice._id],
      memberUserIds: [alice._id],
      discordActiveWebhookUrl: 'https://discord.com/api/webhooks/111/community-token',
    });

    const sessions = [makeActiveSession(alice._id.toString(), 'alice')];

    updateActiveSessionsEmbed(sessions);
    await waitForCalls(mockSend, 2);

    expect(mockSend).toHaveBeenCalledTimes(2);
    const titles = mockSend.mock.calls.map((c) => (c[0] as { embeds: { data: Record<string, unknown> }[] }).embeds[0].data.title);
    expect(titles).toEqual(expect.arrayContaining(['Active Splashers — Alice Squad', 'Active Session — alice']));
  });

  it('still posts an empty personal embed when the splasher has no active session', async () => {
    await User.create({
      username: 'alice',
      passwordHash: 'h',
      token: 't1',
      isAdmin: false,
      setupLinkUsed: true,
      discordActiveWebhookUrl: 'https://discord.com/api/webhooks/444/alice-personal',
    });

    updateActiveSessionsEmbed([]);
    await waitForCalls(mockSend, 1);

    const body = mockSend.mock.calls[0][0] as { embeds: { data: Record<string, unknown> }[] };
    const fields = body.embeds[0].data.fields as { name: string }[];
    expect(fields[0].name).toBe('No active splashers');
  });
});
