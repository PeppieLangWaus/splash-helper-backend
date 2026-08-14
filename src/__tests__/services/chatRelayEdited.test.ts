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

// Real chatBroadcast (not mocked) so the buffer/correlation behavior itself is exercised end to
// end — see websocket/handlers.test.ts's "Edited message correlation" suite for chatBroadcast's
// own direct unit coverage; this file only checks that chatRelay.ts feeds it the right `source`.

// Same reasoning as services/chatRelay.test.ts: force the binding cache to always refresh, and
// use a short dedup window so these tests don't have to wait out the real 10s default. Has to be
// a `require` (not a static `import`) for chatRelay — imports get hoisted above plain statements
// and would read these env vars too late.
process.env.CHAT_RELAY_CACHE_TTL_MS = '0';
process.env.CHAT_RELAY_DEDUP_WINDOW_MS = '100';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const chatRelay = require('../../services/chatRelay') as typeof import('../../services/chatRelay');
const { parseChatRelayMessage, handleChatRelayPayload, resetChatRelayDedupState } = chatRelay;

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
});

/** Builds a "Full mode" plugin payload matching the current RawChatRelayMessage shape (nested
 *  message/user/friendsChat), not the older flat wire format some other tests in this suite
 *  still use. */
function makeFullModeMessage(overrides: Record<string, unknown> = {}): unknown {
  return {
    message: { id: 42, timestamp: 1_700_000_000, type: 'FRIENDSCHAT', text: 'ge price of a whip: <resolving>', edited: false },
    user: { name: 'Zezima' },
    friendsChat: { name: 'Ardy Splash' },
    ...overrides,
  };
}

describe('parseChatRelayMessage — edited resend fields', () => {
  it('defaults edited to false and captures the source id/timestamp/type', () => {
    const parsed = parseChatRelayMessage(makeFullModeMessage());
    expect(parsed).toMatchObject({
      edited: false,
      sourceId: 42,
      sourceTimestamp: 1_700_000_000,
      sourceType: 'FRIENDSCHAT',
    });
  });

  it('reads edited: true', () => {
    const parsed = parseChatRelayMessage(
      makeFullModeMessage({ message: { id: 42, timestamp: 1_700_000_000, type: 'FRIENDSCHAT', text: 'resolved', edited: true } }),
    );
    expect(parsed?.edited).toBe(true);
  });

  it('rejects a message missing a numeric id or timestamp', () => {
    expect(
      parseChatRelayMessage(makeFullModeMessage({ message: { timestamp: 1, type: 'FRIENDSCHAT', text: 'hi' } })),
    ).toBeNull();
    expect(
      parseChatRelayMessage(makeFullModeMessage({ message: { id: 1, type: 'FRIENDSCHAT', text: 'hi' } })),
    ).toBeNull();
  });
});

describe('parseChatRelayMessage — clan message type variants', () => {
  /** Same shape as makeFullModeMessage, but for a `clanChat` container instead of `friendsChat`. */
  function makeClanMessage(type: string, overrides: Record<string, unknown> = {}): unknown {
    return {
      message: { id: 42, timestamp: 1_700_000_000, type, text: 'gz on the drop' },
      user: { name: 'Zezima', clanRank: { rank: 100, title: 'Owner' } },
      clanChat: { name: 'Ardy Splash CC' },
      ...overrides,
    };
  }

  // CLAN_CHAT (own clan), CLAN_GUEST_CHAT (viewing another clan as a guest), and CLAN_GIM_CHAT
  // (Group Ironman clan) are three distinct RuneLite ChatMessageType values for what is, from this
  // backend's point of view, the same "clan chat" concept — all three must classify as 'cc', or a
  // message from a guest/GIM clan channel is silently dropped as unparseable (see the matching
  // comment on MESSAGE_TYPE_TO_CHANNEL_TYPE in chatRelay.ts).
  it.each(['CLAN_CHAT', 'CLAN_GUEST_CHAT', 'CLAN_GIM_CHAT'])('classifies a %s message as cc', (type) => {
    const parsed = parseChatRelayMessage(makeClanMessage(type));
    expect(parsed?.channelType).toBe('cc');
    expect(parsed?.chatName).toBe('Ardy Splash CC');
  });

  it('rejects a clan system-message type (not an actual chat line)', () => {
    expect(parseChatRelayMessage(makeClanMessage('CLAN_MESSAGE'))).toBeNull();
  });
});

describe('handleChatRelayPayload — edited resend correlation end to end', () => {
  async function registerCommunity() {
    const community = await Community.create({ name: 'Ardy Hosts', ownerIds: [new Types.ObjectId()], memberUserIds: [] });
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });
    return community;
  }

  it('updates the original buffered message in place rather than appending a duplicate', async () => {
    const community = await registerCommunity();
    const communityId = (community._id as Types.ObjectId).toString();

    await handleChatRelayPayload(makeFullModeMessage(), '1.2.3.4');
    await handleChatRelayPayload(
      makeFullModeMessage({
        message: { id: 42, timestamp: 1_700_000_000, type: 'FRIENDSCHAT', text: 'ge price of a whip: 1,234,567', edited: true },
      }),
      '1.2.3.4',
    );

    const ws = new MockWebSocket() as unknown as WebSocket;
    subscribeChat(ws, communityId, 'fc');
    const recent = (ws as unknown as MockWebSocket).recentFromSubscribeAck();

    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ message: 'ge price of a whip: 1,234,567', edited: true });
  });

  it('inserts as a new message when no original with that source is buffered', async () => {
    const community = await registerCommunity();
    const communityId = (community._id as Types.ObjectId).toString();

    await handleChatRelayPayload(
      makeFullModeMessage({
        message: { id: 99, timestamp: 1_700_000_555, type: 'FRIENDSCHAT', text: 'resolved, original never arrived', edited: true },
      }),
      '1.2.3.4',
    );

    const ws = new MockWebSocket() as unknown as WebSocket;
    subscribeChat(ws, communityId, 'fc');
    const recent = (ws as unknown as MockWebSocket).recentFromSubscribeAck();

    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ message: 'resolved, original never arrived', edited: true });
  });
});
