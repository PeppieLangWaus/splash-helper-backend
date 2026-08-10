import request from 'supertest';
import { Types } from 'mongoose';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { Community } from '../../models/Community';
import { ChatChannelName } from '../../models/ChatChannelName';

// Prevent actual Discord calls; spy on the forward call so tests can assert on it.
const forwardChatWebhookPayload = jest.fn();
jest.mock('../../services/discordWebhook', () => {
  const actual = jest.requireActual('../../services/discordWebhook');
  return {
    ...actual,
    forwardChatWebhookPayload: (...args: unknown[]) => forwardChatWebhookPayload(...args),
  };
});

const broadcastChatMessage = jest.fn();
jest.mock('../../websocket/chatBroadcast', () => ({
  broadcastChatMessage: (...args: unknown[]) => broadcastChatMessage(...args),
}));

// Same reasoning as services/chatRelay.test.ts: force the binding cache to always refresh so
// one test's registered chat name can't leak into the next. Has to be a `require` (not a static
// `import`) for createTestApp — imports get hoisted above plain statements and would pull in
// services/chatRelay (via routes/chatRelay) before this env var is set.
process.env.CHAT_RELAY_CACHE_TTL_MS = '0';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createTestApp } = require('../testApp') as typeof import('../testApp');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resetChatRelayDedupState } = require('../../services/chatRelay') as typeof import('../../services/chatRelay');

const app = createTestApp();

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

function makeRawMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 1417339442575,
    timestamp: '2021-01-01T00:00:00.000000000Z',
    chatType: 'FRIENDS',
    chatName: 'Ardy Splash',
    sender: 'Zezima',
    rank: -1,
    message: 'hello from the relay',
    ...overrides,
  };
}

describe('POST /api/chat-relay', () => {
  async function registerCommunity() {
    const community = await Community.create({
      name: 'Ardy Hosts',
      ownerIds: [new Types.ObjectId()],
      memberUserIds: [],
      discordFriendsChatWebhookUrl: 'https://discord.com/api/webhooks/1/token',
    });
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });
    return community;
  }

  it('always responds 204, even for garbage input', async () => {
    const res = await request(app).post('/api/chat-relay').send({ nonsense: true });
    expect(res.status).toBe(204);
    expect(broadcastChatMessage).not.toHaveBeenCalled();
  });

  it('classifies and broadcasts a single chat-line request', async () => {
    await registerCommunity();

    const res = await request(app)
      .post('/api/chat-relay')
      .send(makeRawMessage());

    expect(res.status).toBe(204);
    expect(broadcastChatMessage).toHaveBeenCalledWith(
      expect.any(String),
      'fc',
      'Zezima',
      'hello from the relay',
      undefined,
    );
    expect(forwardChatWebhookPayload).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/1/token',
      { content: '**[Ardy Splash]** **Zezima** : hello from the relay' },
    );
  });

  it('handles each request independently across multiple POSTs', async () => {
    await registerCommunity();

    const first = await request(app).post('/api/chat-relay').send(makeRawMessage({ id: 1, message: 'first' }));
    const second = await request(app)
      .post('/api/chat-relay')
      .send(makeRawMessage({ id: 2, sender: 'Woox', message: 'second' }));
    const third = await request(app)
      .post('/api/chat-relay')
      .send(makeRawMessage({ id: 3, sender: 'Durial321', message: 'third' }));

    expect([first.status, second.status, third.status]).toEqual([204, 204, 204]);
    expect(broadcastChatMessage).toHaveBeenCalledTimes(3);
  });

  it('drops a duplicate message relayed again in a separate request (e.g. by another client)', async () => {
    await registerCommunity();

    await request(app).post('/api/chat-relay').send(makeRawMessage({ id: 1 }));
    const res = await request(app).post('/api/chat-relay').send(makeRawMessage({ id: 2 })); // same content, different client-local id

    expect(res.status).toBe(204);
    expect(broadcastChatMessage).toHaveBeenCalledTimes(1);
  });

  it('still drops unregistered/malformed content with a 204 and no broadcast', async () => {
    const res = await request(app)
      .post('/api/chat-relay')
      .send(makeRawMessage({ chatName: 'Nobody Claims This' }));

    expect(res.status).toBe(204);
    expect(broadcastChatMessage).not.toHaveBeenCalled();
    expect(forwardChatWebhookPayload).not.toHaveBeenCalled();
  });

  it('drops an array body with a 204 and no broadcast', async () => {
    const res = await request(app).post('/api/chat-relay').send([makeRawMessage()]);

    expect(res.status).toBe(204);
    expect(broadcastChatMessage).not.toHaveBeenCalled();
  });

  it('resolves a recognized rank to its icon on the broadcast payload', async () => {
    await registerCommunity();

    await request(app)
      .post('/api/chat-relay')
      .send(makeRawMessage({ rank: 7 })); // FriendsChatRank.OWNER

    expect(broadcastChatMessage).toHaveBeenCalledWith(
      expect.any(String),
      'fc',
      'Zezima',
      'hello from the relay',
      expect.objectContaining({ rank: 7, name: 'Owner' }),
    );
  });
});
