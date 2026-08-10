import { Types } from 'mongoose';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { ChatMessage } from '../../models/ChatMessage';
import { persistChatMessage, getRecentChatMessages } from '../../services/chatHistory';
import { ChatBroadcastMessage } from '../../types';

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
});

function makeMessage(overrides: Partial<ChatBroadcastMessage> = {}): ChatBroadcastMessage {
  return {
    id: 'live-id',
    communityId: new Types.ObjectId().toString(),
    channelType: 'fc',
    sender: 'Zezima',
    message: 'hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('persistChatMessage', () => {
  it('stores a message so it can be loaded back', async () => {
    const communityId = new Types.ObjectId().toString();
    await persistChatMessage(makeMessage({ communityId, message: 'anyone selling nats?' }));

    const loaded = await getRecentChatMessages(communityId, 'fc', 50);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      communityId,
      channelType: 'fc',
      sender: 'Zezima',
      message: 'anyone selling nats?',
    });
  });

  it('persists optional rank fields when present, and omits them when absent', async () => {
    const communityId = new Types.ObjectId().toString();
    const base = Date.now();
    await persistChatMessage(
      makeMessage({
        communityId,
        timestamp: base,
        rank: 7,
        rankName: 'Owner',
        rankIconUrl: 'https://example.com/owner.png',
      }),
    );
    await persistChatMessage(makeMessage({ communityId, timestamp: base + 1000, message: 'unranked message' }));

    const loaded = await getRecentChatMessages(communityId, 'fc', 50);
    expect(loaded[0]).toMatchObject({ rank: 7, rankName: 'Owner', rankIconUrl: 'https://example.com/owner.png' });
    expect(loaded[1]).not.toHaveProperty('rank');
  });

  it('does not throw when the payload is malformed — a persistence failure must not break the relay', async () => {
    await expect(persistChatMessage(undefined as unknown as ChatBroadcastMessage)).resolves.toBeUndefined();
  });

  it('keeps FC and CC history separate for the same community', async () => {
    const communityId = new Types.ObjectId().toString();
    await persistChatMessage(makeMessage({ communityId, channelType: 'fc', message: 'fc line' }));
    await persistChatMessage(makeMessage({ communityId, channelType: 'cc', message: 'cc line' }));

    const fc = await getRecentChatMessages(communityId, 'fc', 50);
    const cc = await getRecentChatMessages(communityId, 'cc', 50);
    expect(fc).toHaveLength(1);
    expect(fc[0].message).toBe('fc line');
    expect(cc).toHaveLength(1);
    expect(cc[0].message).toBe('cc line');
  });

  it('keeps history separate across communities', async () => {
    const communityA = new Types.ObjectId().toString();
    const communityB = new Types.ObjectId().toString();
    await persistChatMessage(makeMessage({ communityId: communityA, message: 'from A' }));
    await persistChatMessage(makeMessage({ communityId: communityB, message: 'from B' }));

    expect((await getRecentChatMessages(communityA, 'fc', 50)).map((m) => m.message)).toEqual(['from A']);
    expect((await getRecentChatMessages(communityB, 'fc', 50)).map((m) => m.message)).toEqual(['from B']);
  });
});

describe('getRecentChatMessages', () => {
  it('returns messages oldest-first', async () => {
    const communityId = new Types.ObjectId().toString();
    const base = Date.now();
    await persistChatMessage(makeMessage({ communityId, message: 'first', timestamp: base }));
    await persistChatMessage(makeMessage({ communityId, message: 'second', timestamp: base + 1000 }));
    await persistChatMessage(makeMessage({ communityId, message: 'third', timestamp: base + 2000 }));

    const loaded = await getRecentChatMessages(communityId, 'fc', 50);
    expect(loaded.map((m) => m.message)).toEqual(['first', 'second', 'third']);
  });

  it('respects the requested limit, keeping the most recent messages', async () => {
    const communityId = new Types.ObjectId().toString();
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await persistChatMessage(makeMessage({ communityId, message: `msg-${i}`, timestamp: base + i * 1000 }));
    }

    const loaded = await getRecentChatMessages(communityId, 'fc', 2);
    expect(loaded.map((m) => m.message)).toEqual(['msg-3', 'msg-4']);
  });

  it('returns an empty array when nothing is stored', async () => {
    const loaded = await getRecentChatMessages(new Types.ObjectId().toString(), 'fc', 50);
    expect(loaded).toEqual([]);
  });

  it('prunes older messages once a channel exceeds the stored cap', async () => {
    const communityId = new Types.ObjectId().toString();
    const base = Date.now();
    // Cap is 200 (MAX_HISTORY_LIMIT) — insert one over.
    for (let i = 0; i < 201; i++) {
      await persistChatMessage(makeMessage({ communityId, message: `msg-${i}`, timestamp: base + i * 1000 }));
    }

    const count = await ChatMessage.countDocuments({ communityId, channelType: 'fc' });
    expect(count).toBe(200);

    const loaded = await getRecentChatMessages(communityId, 'fc', 200);
    expect(loaded[0].message).toBe('msg-1'); // oldest (msg-0) was pruned
    expect(loaded[loaded.length - 1].message).toBe('msg-200');
  }, 20000);
});
