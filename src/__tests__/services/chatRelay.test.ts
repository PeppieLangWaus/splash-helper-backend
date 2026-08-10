import { Types } from 'mongoose';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { Community } from '../../models/Community';
import { ChatChannelName } from '../../models/ChatChannelName';

// Prevent actual Discord calls; spy on the forward call so tests can assert on it.
const forwardChatWebhookPayload = jest.fn();
jest.mock('../../services/discordWebhook', () => ({
  forwardChatWebhookPayload: (...args: unknown[]) => forwardChatWebhookPayload(...args),
}));

// Chat broadcast is exercised separately (websocket/handlers.test.ts); stub it here so this
// file stays focused on parsing/classification/dedup/blocking.
const broadcastChatMessage = jest.fn();
jest.mock('../../websocket/chatBroadcast', () => ({
  broadcastChatMessage: (...args: unknown[]) => broadcastChatMessage(...args),
}));

// The relay's classification cache defaults to a 15s TTL, far longer than this suite takes to
// run — without forcing it to always refresh, one test's registered chat name would leak
// (stale) into the next test that reuses the same name against a since-deleted community. This
// has to be a `require` (not a static `import`), since imports get hoisted above plain
// statements and would read the env var too early.
process.env.CHAT_RELAY_CACHE_TTL_MS = '0';
// Kept short (rather than the real 10s default) so the "window has passed" test below can wait
// it out with a real delay instead of fake timers, which would also stall the real Mongo I/O
// every other test in this file depends on.
process.env.CHAT_RELAY_DEDUP_WINDOW_MS = '100';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const chatRelay = require('../../services/chatRelay') as typeof import('../../services/chatRelay');
const {
  parseChatRelayMessage,
  handleChatRelayPayload,
  isChatChannelNameTaken,
  resolveChatChannelNameField,
  applyChatChannelNameUpdate,
  resetChatRelayDedupState,
} = chatRelay;

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
  jest.clearAllMocks();
  resetChatRelayDedupState();
});

function makeRawMessage(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 1417339442575,
    timestamp: '2021-01-01T00:00:00.000000000Z',
    chatType: 'FRIENDS',
    chatName: 'Ardy Splash',
    sender: 'Zezima',
    rank: -1,
    message: 'anyone selling nats?',
    ...overrides,
  };
}

describe('parseChatRelayMessage', () => {
  it('parses a well-formed Friends Chat message', () => {
    expect(parseChatRelayMessage(makeRawMessage())).toEqual({
      channelType: 'fc',
      chatName: 'Ardy Splash',
      sender: 'Zezima',
      rank: -1,
      message: 'anyone selling nats?',
    });
  });

  it('parses a well-formed Clan message', () => {
    expect(parseChatRelayMessage(makeRawMessage({ chatType: 'CLAN', chatName: 'Ardy Splash CC', rank: 100 }))).toEqual({
      channelType: 'cc',
      chatName: 'Ardy Splash CC',
      sender: 'Zezima',
      rank: 100,
      message: 'anyone selling nats?',
    });
  });

  it('returns null for garbage / non-object input', () => {
    expect(parseChatRelayMessage(null)).toBeNull();
    expect(parseChatRelayMessage(undefined)).toBeNull();
    expect(parseChatRelayMessage('nope')).toBeNull();
    expect(parseChatRelayMessage(42)).toBeNull();
  });

  it('returns null for an unrecognized chatType', () => {
    expect(parseChatRelayMessage(makeRawMessage({ chatType: 'TRADE' }))).toBeNull();
    expect(parseChatRelayMessage(makeRawMessage({ chatType: undefined }))).toBeNull();
  });

  it('returns null for a missing/blank/oversized chatName or sender', () => {
    expect(parseChatRelayMessage(makeRawMessage({ chatName: '' }))).toBeNull();
    expect(parseChatRelayMessage(makeRawMessage({ chatName: '   ' }))).toBeNull();
    expect(parseChatRelayMessage(makeRawMessage({ chatName: 'a'.repeat(101) }))).toBeNull();
    expect(parseChatRelayMessage(makeRawMessage({ sender: '' }))).toBeNull();
    expect(parseChatRelayMessage(makeRawMessage({ sender: 'a'.repeat(101) }))).toBeNull();
  });

  it('returns null for a non-numeric rank', () => {
    expect(parseChatRelayMessage(makeRawMessage({ rank: '5' }))).toBeNull();
    expect(parseChatRelayMessage(makeRawMessage({ rank: NaN }))).toBeNull();
  });

  it('returns null for empty/oversized message content', () => {
    expect(parseChatRelayMessage(makeRawMessage({ message: '' }))).toBeNull();
    expect(parseChatRelayMessage(makeRawMessage({ message: '   ' }))).toBeNull();
    expect(parseChatRelayMessage(makeRawMessage({ message: 'a'.repeat(2001) }))).toBeNull();
  });

  it('trims chatName, sender, and message', () => {
    const parsed = parseChatRelayMessage(
      makeRawMessage({ chatName: '  Ardy Splash  ', sender: '  Zezima  ', message: '  hello  ' }),
    );
    expect(parsed).toEqual({
      channelType: 'fc',
      chatName: 'Ardy Splash',
      sender: 'Zezima',
      rank: -1,
      message: 'hello',
    });
  });
});

describe('chat channel name registration', () => {
  it('is not taken when unregistered', async () => {
    const id = new Types.ObjectId();
    expect(await isChatChannelNameTaken('ardy splash', 'fc', id)).toBe(false);
  });

  it('is taken when registered to a different community', async () => {
    const ownerId = new Types.ObjectId();
    const otherId = new Types.ObjectId();
    await ChatChannelName.create({
      communityId: ownerId,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });
    expect(await isChatChannelNameTaken('ardy splash', 'fc', otherId)).toBe(true);
    expect(await isChatChannelNameTaken('ardy splash', 'fc', ownerId)).toBe(false);
  });

  it('is not taken as a different channel type — FC and CC are separate namespaces', async () => {
    const ownerId = new Types.ObjectId();
    const otherId = new Types.ObjectId();
    await ChatChannelName.create({
      communityId: ownerId,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });
    // Same name, but as a CC — free for both the owning community and any other.
    expect(await isChatChannelNameTaken('ardy splash', 'cc', ownerId)).toBe(false);
    expect(await isChatChannelNameTaken('ardy splash', 'cc', otherId)).toBe(false);
  });

  it('resolveChatChannelNameField reports taken/invalid/set/clear/skip correctly', async () => {
    const ownerId = new Types.ObjectId();
    const otherId = new Types.ObjectId();
    await ChatChannelName.create({
      communityId: ownerId,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });

    expect(await resolveChatChannelNameField(undefined, otherId, 'fc')).toEqual({ action: 'skip' });
    expect(await resolveChatChannelNameField('', otherId, 'fc')).toEqual({ action: 'clear' });
    expect(await resolveChatChannelNameField(42, otherId, 'fc')).toEqual({ action: 'invalid' });
    expect(await resolveChatChannelNameField('a'.repeat(101), otherId, 'fc')).toEqual({ action: 'invalid' });
    expect(await resolveChatChannelNameField('Ardy Splash', otherId, 'fc')).toEqual({ action: 'taken' });
    expect(await resolveChatChannelNameField('Ardy Splash', ownerId, 'fc')).toEqual({ action: 'set', value: 'Ardy Splash' });
    expect(await resolveChatChannelNameField('New Name', otherId, 'fc')).toEqual({ action: 'set', value: 'New Name' });
    // Same name, registered as the other channel type — not taken.
    expect(await resolveChatChannelNameField('Ardy Splash', otherId, 'cc')).toEqual({ action: 'set', value: 'Ardy Splash' });
  });

  it('applyChatChannelNameUpdate upserts on set and removes on clear', async () => {
    const communityId = new Types.ObjectId();

    await applyChatChannelNameUpdate(communityId, 'cc', { action: 'set', value: 'My Clan' });
    let doc = await ChatChannelName.findOne({ communityId, channelType: 'cc' }).lean();
    expect(doc?.name).toBe('My Clan');
    expect(doc?.normalizedName).toBe('my clan');

    await applyChatChannelNameUpdate(communityId, 'cc', { action: 'clear' });
    doc = await ChatChannelName.findOne({ communityId, channelType: 'cc' }).lean();
    expect(doc).toBeNull();
  });

  it('allows the same name to be registered as both a community\'s FC and CC without crashing', async () => {
    const communityId = new Types.ObjectId();

    await applyChatChannelNameUpdate(communityId, 'fc', { action: 'set', value: 'Ardy Splash' });
    await applyChatChannelNameUpdate(communityId, 'cc', { action: 'set', value: 'Ardy Splash' });

    const fcDoc = await ChatChannelName.findOne({ communityId, channelType: 'fc' }).lean();
    const ccDoc = await ChatChannelName.findOne({ communityId, channelType: 'cc' }).lean();
    expect(fcDoc?.normalizedName).toBe('ardy splash');
    expect(ccDoc?.normalizedName).toBe('ardy splash');
  });

  it('allows the same name to be registered as an FC by one community and a CC by another', async () => {
    const communityA = new Types.ObjectId();
    const communityB = new Types.ObjectId();

    await applyChatChannelNameUpdate(communityA, 'fc', { action: 'set', value: 'Ardy Splash' });
    await applyChatChannelNameUpdate(communityB, 'cc', { action: 'set', value: 'Ardy Splash' });

    const fcDoc = await ChatChannelName.findOne({ communityId: communityA, channelType: 'fc' }).lean();
    const ccDoc = await ChatChannelName.findOne({ communityId: communityB, channelType: 'cc' }).lean();
    expect(fcDoc?.normalizedName).toBe('ardy splash');
    expect(ccDoc?.normalizedName).toBe('ardy splash');
  });
});

describe('handleChatRelayPayload', () => {
  async function makeCommunity(overrides: Record<string, unknown> = {}) {
    return Community.create({
      name: 'Ardy Hosts',
      ownerIds: [new Types.ObjectId()],
      memberUserIds: [],
      ...overrides,
    });
  }

  it('drops content that does not look like plugin output', async () => {
    const result = await handleChatRelayPayload({ nonsense: true }, '1.2.3.4');
    expect(result).toEqual({ status: 'dropped', reason: 'invalid-format' });
    expect(forwardChatWebhookPayload).not.toHaveBeenCalled();
    expect(broadcastChatMessage).not.toHaveBeenCalled();
  });

  it('drops a well-formed message whose chat name is not registered to any community', async () => {
    const result = await handleChatRelayPayload(makeRawMessage({ chatName: 'Nobody Claims This' }), '1.2.3.4');
    expect(result).toEqual({ status: 'dropped', reason: 'unrecognized-source' });
    expect(forwardChatWebhookPayload).not.toHaveBeenCalled();
    expect(broadcastChatMessage).not.toHaveBeenCalled();
  });

  it('drops a message whose claimed chatType disagrees with the name\'s registered channel type', async () => {
    const community = await makeCommunity();
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });

    // Registered as FC, but the message claims CLAN.
    const result = await handleChatRelayPayload(makeRawMessage({ chatType: 'CLAN' }), '1.2.3.4');
    expect(result).toEqual({ status: 'dropped', reason: 'unrecognized-source' });
    expect(broadcastChatMessage).not.toHaveBeenCalled();
  });

  it('classifies, forwards to Discord, and broadcasts a recognized Friends Chat message', async () => {
    const community = await makeCommunity({ discordFriendsChatWebhookUrl: 'https://discord.com/api/webhooks/1/token' });
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });

    const result = await handleChatRelayPayload(makeRawMessage(), '1.2.3.4');

    expect(result).toEqual({
      status: 'forwarded',
      communityId: (community._id as Types.ObjectId).toString(),
      channelType: 'fc',
    });
    expect(forwardChatWebhookPayload).toHaveBeenCalledWith('https://discord.com/api/webhooks/1/token', {
      content: '**[Ardy Splash]** **Zezima** : anyone selling nats?',
    });
    expect(broadcastChatMessage).toHaveBeenCalledWith(
      (community._id as Types.ObjectId).toString(),
      'fc',
      'Zezima',
      'anyone selling nats?',
      undefined, // rank -1 (unranked) has no resolvable icon
    );
  });

  it('resolves a named Friends Chat rank to its display name + icon', async () => {
    const community = await makeCommunity();
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });

    await handleChatRelayPayload(makeRawMessage({ rank: 6 }), '1.2.3.4');

    expect(broadcastChatMessage).toHaveBeenCalledWith(
      (community._id as Types.ObjectId).toString(),
      'fc',
      'Zezima',
      'anyone selling nats?',
      { rank: 6, name: 'General', iconUrl: expect.stringContaining('General_clan_rank.png') },
    );
  });

  it('resolves a named Clan rank to its display name + icon, and passes through an unnamed custom rank tier', async () => {
    const community = await makeCommunity();
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'cc',
      name: 'Ardy Splash CC',
      normalizedName: 'ardy splash cc',
    });

    await handleChatRelayPayload(makeRawMessage({ chatType: 'CLAN', chatName: 'Ardy Splash CC', rank: 126 }), '1.2.3.4');
    expect(broadcastChatMessage).toHaveBeenCalledWith(
      (community._id as Types.ObjectId).toString(),
      'cc',
      'Zezima',
      'anyone selling nats?',
      { rank: 126, name: 'Owner', iconUrl: expect.stringContaining('Clan_icon_-_Owner.png') },
    );

    jest.clearAllMocks();
    resetChatRelayDedupState();

    // Rank 42 is one of a clan's own custom-titled tiers -- ClanRank.java has no fixed name for
    // it, so it should broadcast with no rank info rather than a guessed name/icon.
    await handleChatRelayPayload(makeRawMessage({ chatType: 'CLAN', chatName: 'Ardy Splash CC', rank: 42 }), '1.2.3.4');
    expect(broadcastChatMessage).toHaveBeenCalledWith(
      (community._id as Types.ObjectId).toString(),
      'cc',
      'Zezima',
      'anyone selling nats?',
      undefined,
    );
  });

  it('routes an FC and a CC sharing the same name to their own communities without crosstalk', async () => {
    const fcCommunity = await makeCommunity({ name: 'FC Owner' });
    const ccCommunity = await makeCommunity({ name: 'CC Owner' });
    await ChatChannelName.create({
      communityId: fcCommunity._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });
    await ChatChannelName.create({
      communityId: ccCommunity._id,
      channelType: 'cc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });

    const fcResult = await handleChatRelayPayload(makeRawMessage({ chatType: 'FRIENDS', chatName: 'Ardy Splash' }), '1.2.3.4');
    const ccResult = await handleChatRelayPayload(makeRawMessage({ chatType: 'CLAN', chatName: 'Ardy Splash' }), '5.6.7.8');

    expect(fcResult).toEqual({
      status: 'forwarded',
      communityId: (fcCommunity._id as Types.ObjectId).toString(),
      channelType: 'fc',
    });
    expect(ccResult).toEqual({
      status: 'forwarded',
      communityId: (ccCommunity._id as Types.ObjectId).toString(),
      channelType: 'cc',
    });
  });

  it('does not forward to Discord when the community has no chat webhook configured, but still broadcasts', async () => {
    const community = await makeCommunity();
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });

    const result = await handleChatRelayPayload(makeRawMessage(), '1.2.3.4');
    expect(result.status).toBe('forwarded');
    expect(forwardChatWebhookPayload).not.toHaveBeenCalled();
    expect(broadcastChatMessage).toHaveBeenCalledTimes(1);
  });

  it('drops messages from a source blocked by IP', async () => {
    const community = await makeCommunity({
      blockedChatSources: [{ ip: '9.9.9.9', blockedAt: new Date() }],
    });
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });

    const result = await handleChatRelayPayload(makeRawMessage(), '9.9.9.9');
    expect(result).toEqual({ status: 'dropped', reason: 'blocked' });
    expect(forwardChatWebhookPayload).not.toHaveBeenCalled();
    expect(broadcastChatMessage).not.toHaveBeenCalled();
  });

  it('drops messages from a source blocked by claimed player name, case-insensitively', async () => {
    const community = await makeCommunity({
      blockedChatSources: [{ playerName: 'griefer', blockedAt: new Date() }],
    });
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });

    const result = await handleChatRelayPayload(makeRawMessage({ sender: 'Griefer', message: 'spam spam spam' }), '1.2.3.4');
    expect(result).toEqual({ status: 'dropped', reason: 'blocked' });
  });

  it('does not block an unrelated IP/name after blocking a different one', async () => {
    const community = await makeCommunity({
      blockedChatSources: [{ ip: '9.9.9.9', blockedAt: new Date() }],
    });
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });

    const result = await handleChatRelayPayload(makeRawMessage(), '1.2.3.4');
    expect(result.status).toBe('forwarded');
  });

  describe('deduplication', () => {
    async function registerCommunity() {
      const community = await makeCommunity();
      await ChatChannelName.create({
        communityId: community._id,
        channelType: 'fc',
        name: 'Ardy Splash',
        normalizedName: 'ardy splash',
      });
      return community;
    }

    it('drops an identical message relayed again (e.g. by a second client in the same chat)', async () => {
      await registerCommunity();

      const first = await handleChatRelayPayload(makeRawMessage({ id: 1 }), '1.2.3.4');
      const second = await handleChatRelayPayload(makeRawMessage({ id: 2 }), '5.6.7.8');

      expect(first.status).toBe('forwarded');
      expect(second).toEqual({ status: 'dropped', reason: 'duplicate' });
      expect(broadcastChatMessage).toHaveBeenCalledTimes(1);
    });

    it('treats messages differing only by unrelated `id` as duplicates, since id is never shared across clients', async () => {
      await registerCommunity();

      await handleChatRelayPayload(makeRawMessage({ id: 111 }), '1.2.3.4');
      const result = await handleChatRelayPayload(makeRawMessage({ id: 999, timestamp: '2021-01-01T00:00:01.000000000Z' }), '1.2.3.4');

      expect(result).toEqual({ status: 'dropped', reason: 'duplicate' });
    });

    it('does not treat a different message from the same sender as a duplicate', async () => {
      await registerCommunity();

      const first = await handleChatRelayPayload(makeRawMessage({ message: 'first message' }), '1.2.3.4');
      const second = await handleChatRelayPayload(makeRawMessage({ message: 'second message' }), '1.2.3.4');

      expect(first.status).toBe('forwarded');
      expect(second.status).toBe('forwarded');
      expect(broadcastChatMessage).toHaveBeenCalledTimes(2);
    });

    it('does not treat the same message text from a different sender, or a different chat, as a duplicate', async () => {
      const community = await registerCommunity();
      await ChatChannelName.create({
        communityId: community._id,
        channelType: 'cc',
        name: 'Ardy Splash CC',
        normalizedName: 'ardy splash cc',
      });

      const first = await handleChatRelayPayload(makeRawMessage({ sender: 'Zezima' }), '1.2.3.4');
      const second = await handleChatRelayPayload(makeRawMessage({ sender: 'Woox' }), '5.6.7.8');
      const third = await handleChatRelayPayload(
        makeRawMessage({ chatType: 'CLAN', chatName: 'Ardy Splash CC' }),
        '9.9.9.9',
      );

      expect(first.status).toBe('forwarded');
      expect(second.status).toBe('forwarded');
      expect(third.status).toBe('forwarded');
      expect(broadcastChatMessage).toHaveBeenCalledTimes(3);
    });

    it('allows the same message again once the dedup window has passed', async () => {
      await registerCommunity();

      const first = await handleChatRelayPayload(makeRawMessage(), '1.2.3.4');
      await new Promise((resolve) => setTimeout(resolve, 150)); // window is 100ms in this suite
      const second = await handleChatRelayPayload(makeRawMessage(), '1.2.3.4');

      expect(first.status).toBe('forwarded');
      expect(second.status).toBe('forwarded');
      expect(broadcastChatMessage).toHaveBeenCalledTimes(2);
    });
  });
});
