import { Types } from 'mongoose';
import { WebSocket } from 'ws';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { Community } from '../../models/Community';
import { ChatChannelName } from '../../models/ChatChannelName';
import { subscribeChat } from '../../websocket/chatBroadcast';

// Prevent actual Discord calls; not under test here.
jest.mock('../../services/discordWebhook', () => ({
  forwardChatWebhookPayload: jest.fn(),
}));

// `detectItemLogCommand` is pure (no network) and left real via requireActual; only
// `resolveItemLogCommand` — the part that actually calls RuneProfile's/RuneLite's public APIs —
// is stubbed, so this suite never makes a real network call.
const resolveItemLogCommand = jest.fn();
jest.mock('../../services/itemLogResolver', () => ({
  ...jest.requireActual('../../services/itemLogResolver'),
  resolveItemLogCommand: (...args: unknown[]) => resolveItemLogCommand(...args),
}));

// Real chatBroadcast (not mocked), same reasoning as chatRelayEdited.test.ts: this suite checks
// what actually ends up in the broadcast payload, not just that chatRelay.ts calls it.

process.env.CHAT_RELAY_CACHE_TTL_MS = '0';
process.env.CHAT_RELAY_DEDUP_WINDOW_MS = '100';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const chatRelay = require('../../services/chatRelay') as typeof import('../../services/chatRelay');
const { handleChatRelayPayload, resetChatRelayDedupState } = chatRelay;

class MockWebSocket {
  public readyState = WebSocket.OPEN;
  public sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  recentFromSubscribeAck(): unknown[] {
    return (JSON.parse(this.sent[0]) as { recent: unknown[] }).recent;
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
  resetChatRelayDedupState();
  resolveItemLogCommand.mockReset();
});

function makeMessage(text: string, id = 1): unknown {
  return {
    message: { id, timestamp: 1_700_000_000, type: 'FRIENDSCHAT', text },
    user: { name: 'Zezima' },
    friendsChat: { name: 'Ardy Splash' },
  };
}

async function registerCommunity() {
  const community = await Community.create({ name: 'Ardy Hosts', ownerIds: [new Types.ObjectId()], memberUserIds: [] });
  await ChatChannelName.create({
    communityId: community._id,
    channelType: 'fc',
    name: 'Ardy Splash',
    normalizedName: 'ardy splash',
  });
  return (community._id as Types.ObjectId).toString();
}

async function broadcastRecent(communityId: string): Promise<unknown[]> {
  const ws = new MockWebSocket() as unknown as WebSocket;
  subscribeChat(ws, communityId, 'fc');
  return (ws as unknown as MockWebSocket).recentFromSubscribeAck();
}

describe('handleChatRelayPayload — item log resolution', () => {
  it('attaches resolved items for a !log <page> message', async () => {
    resolveItemLogCommand.mockResolvedValue([{ id: 8844, quantity: 0 }]);
    const communityId = await registerCommunity();

    await handleChatRelayPayload(makeMessage('!log cyclopes'), '1.2.3.4');

    expect(resolveItemLogCommand).toHaveBeenCalledWith(
      'Zezima',
      { kind: 'collection-log', page: 'cyclopes', missingOnly: false },
    );
    const recent = await broadcastRecent(communityId);
    expect(recent[0]).toMatchObject({ message: '!log cyclopes', items: [{ id: 8844, quantity: 0 }] });
  });

  it('parses "!log missing <page>" and passes missingOnly through', async () => {
    resolveItemLogCommand.mockResolvedValue([]);
    await registerCommunity();

    await handleChatRelayPayload(makeMessage('!log missing cyclopes'), '1.2.3.4');

    expect(resolveItemLogCommand).toHaveBeenCalledWith(
      'Zezima',
      { kind: 'collection-log', page: 'cyclopes', missingOnly: true },
    );
  });

  it('attaches resolved items for a !pets message', async () => {
    resolveItemLogCommand.mockResolvedValue([{ id: 12898, quantity: 1 }]);
    const communityId = await registerCommunity();

    await handleChatRelayPayload(makeMessage('!pets'), '1.2.3.4');

    expect(resolveItemLogCommand).toHaveBeenCalledWith('Zezima', { kind: 'pets' });
    const recent = await broadcastRecent(communityId);
    expect(recent[0]).toMatchObject({ message: '!pets', items: [{ id: 12898, quantity: 1 }] });
  });

  it('keeps an empty resolved list distinct from a failed resolution', async () => {
    resolveItemLogCommand.mockResolvedValue([]);
    const communityId = await registerCommunity();

    await handleChatRelayPayload(makeMessage('!log cyclopes'), '1.2.3.4');

    const recent = await broadcastRecent(communityId);
    expect(recent[0]).toMatchObject({ items: [] });
  });

  it('omits items when resolution fails', async () => {
    resolveItemLogCommand.mockResolvedValue(null);
    const communityId = await registerCommunity();

    await handleChatRelayPayload(makeMessage('!log unknownpage'), '1.2.3.4');

    const recent = await broadcastRecent(communityId);
    expect(recent[0]).not.toHaveProperty('items');
  });

  it('does not call the resolver for an ordinary chat message', async () => {
    await registerCommunity();

    await handleChatRelayPayload(makeMessage('anyone selling nats?'), '1.2.3.4');

    expect(resolveItemLogCommand).not.toHaveBeenCalled();
  });
});
