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
// `resolveItemLogCommand` — the part that actually calls RuneProfile's public API — is stubbed,
// so this suite never makes a real network call.
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
  it('replaces the message with the resolution summary and attaches its items', async () => {
    resolveItemLogCommand.mockResolvedValue({
      summary: 'Cyclopes (1/8):',
      items: [{ id: 8844, quantity: 1 }],
      showQuantities: true,
    });
    const communityId = await registerCommunity();

    await handleChatRelayPayload(makeMessage('!log cyclopes'), '1.2.3.4');

    expect(resolveItemLogCommand).toHaveBeenCalledWith(
      'Zezima',
      { kind: 'collection-log', page: 'cyclopes', missingOnly: false },
    );
    const recent = await broadcastRecent(communityId);
    expect(recent[0]).toMatchObject({
      message: 'Cyclopes (1/8):',
      items: [{ id: 8844, quantity: 1 }],
      showQuantities: true,
    });
  });

  it('parses "!log missing <page>" and passes missingOnly through', async () => {
    resolveItemLogCommand.mockResolvedValue({ summary: 'Cyclopes - missing (7/8):', items: [], showQuantities: true });
    await registerCommunity();

    await handleChatRelayPayload(makeMessage('!log missing cyclopes'), '1.2.3.4');

    expect(resolveItemLogCommand).toHaveBeenCalledWith(
      'Zezima',
      { kind: 'collection-log', page: 'cyclopes', missingOnly: true },
    );
  });

  it('replaces the message and attaches items for a !pets message, with showQuantities false', async () => {
    resolveItemLogCommand.mockResolvedValue({ summary: 'Pets (1):', items: [{ id: 12898, quantity: 1 }], showQuantities: false });
    const communityId = await registerCommunity();

    await handleChatRelayPayload(makeMessage('!pets'), '1.2.3.4');

    expect(resolveItemLogCommand).toHaveBeenCalledWith('Zezima', { kind: 'pets' });
    const recent = await broadcastRecent(communityId);
    expect(recent[0]).toMatchObject({
      message: 'Pets (1):',
      items: [{ id: 12898, quantity: 1 }],
      showQuantities: false,
    });
  });

  it('keeps an empty resolved list distinct from a failed resolution', async () => {
    resolveItemLogCommand.mockResolvedValue({ summary: 'Cyclopes (0/8):', items: [], showQuantities: true });
    const communityId = await registerCommunity();

    await handleChatRelayPayload(makeMessage('!log cyclopes'), '1.2.3.4');

    const recent = await broadcastRecent(communityId);
    expect(recent[0]).toMatchObject({ items: [] });
  });

  it('leaves the original message untouched and omits items when resolution fails', async () => {
    resolveItemLogCommand.mockResolvedValue(null);
    const communityId = await registerCommunity();

    await handleChatRelayPayload(makeMessage('!log unknownpage'), '1.2.3.4');

    const recent = await broadcastRecent(communityId);
    expect(recent[0]).toMatchObject({ message: '!log unknownpage' });
    expect(recent[0]).not.toHaveProperty('items');
  });

  it('does not call the resolver for an ordinary chat message', async () => {
    await registerCommunity();

    await handleChatRelayPayload(makeMessage('anyone selling nats?'), '1.2.3.4');

    expect(resolveItemLogCommand).not.toHaveBeenCalled();
  });
});

describe('handleChatRelayPayload — edited resend does not clobber an already-resolved summary', () => {
  it('keeps the resolved message/items when a later generic edited-resend carries no new items', async () => {
    resolveItemLogCommand.mockResolvedValue({
      summary: 'Cyclopes (1/8):',
      items: [{ id: 8844, quantity: 1 }],
      showQuantities: true,
    });
    const communityId = await registerCommunity();

    await handleChatRelayPayload(makeMessage('!log cyclopes'), '1.2.3.4');

    // Simulate the plugin's own generic PendingCommandMessage follow-up: same source id/
    // timestamp/type, edited: true, text rewritten locally by some other plugin (RuneProfile's
    // own ephemeral <img=N>-laden rewrite) — doesn't match !log/!pets, so no new resolution.
    resolveItemLogCommand.mockClear();
    await handleChatRelayPayload(
      {
        message: { id: 1, timestamp: 1_700_000_000, type: 'FRIENDSCHAT', text: 'Cyclopes (1/8) : <img=412>', edited: true },
        user: { name: 'Zezima' },
        friendsChat: { name: 'Ardy Splash' },
      },
      '1.2.3.4',
    );

    expect(resolveItemLogCommand).not.toHaveBeenCalled();
    const recent = await broadcastRecent(communityId);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      message: 'Cyclopes (1/8):',
      items: [{ id: 8844, quantity: 1 }],
      edited: true,
    });
  });
});
