import { Types } from 'mongoose';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { Community } from '../../models/Community';
import { ChatChannelName } from '../../models/ChatChannelName';

// Not under test here.
jest.mock('../../services/discordWebhook', () => ({ forwardChatWebhookPayload: jest.fn() }));
jest.mock('../../websocket/chatBroadcast', () => ({ broadcastChatMessage: jest.fn() }));

// Same reasoning as chatRelay.test.ts / chatRelayEdited.test.ts: force the binding cache to always
// refresh, and use a short dedup window. Has to be a `require` (not a static `import`) — imports
// get hoisted above plain statements and would read these env vars too late.
process.env.CHAT_RELAY_CACHE_TTL_MS = '0';
process.env.CHAT_RELAY_DEDUP_WINDOW_MS = '100';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const chatRelay = require('../../services/chatRelay') as typeof import('../../services/chatRelay');
const { parseChatRelayMessage, handleChatRelayPayload, resolveChatBinding, resetChatRelayDedupState } = chatRelay;

/** "Full mode" plugin payload matching the current RawChatRelayMessage shape. */
function makeFullModeMessage(overrides: Record<string, unknown> = {}): unknown {
  return {
    message: { id: 1, timestamp: 1_700_000_000, type: 'FRIENDSCHAT', text: 'anyone selling nats?' },
    user: { name: 'Zezima' },
    friendsChat: { name: 'Ardy Splash', owner: 'Woox' },
    ...overrides,
  };
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

describe('parseChatRelayMessage — friendsChat.owner', () => {
  it('captures chatOwner for an FC message', () => {
    const parsed = parseChatRelayMessage(makeFullModeMessage());
    expect(parsed?.chatOwner).toBe('Woox');
  });

  it('never sets chatOwner for a CC message, even if the field were present', () => {
    const parsed = parseChatRelayMessage({
      message: { id: 1, timestamp: 1_700_000_000, type: 'CLAN_CHAT', text: 'gz' },
      user: { name: 'Zezima' },
      clanChat: { name: 'Ardy Splash CC', owner: 'Woox' },
    });
    expect(parsed?.chatOwner).toBeUndefined();
  });

  it('omits chatOwner when friendsChat.owner is absent', () => {
    const parsed = parseChatRelayMessage(makeFullModeMessage({ friendsChat: { name: 'Ardy Splash' } }));
    expect(parsed?.chatOwner).toBeUndefined();
  });
});

describe('resolveChatBinding — Friends Chat classification', () => {
  it('matches an FC doc without a captured owner by name (pre-migration)', async () => {
    const community = await Community.create({ name: 'Ardy Hosts', ownerIds: [new Types.ObjectId()], memberUserIds: [] });
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });

    const binding = await resolveChatBinding('Ardy Splash', 'fc', 'Woox');
    expect(binding).toEqual({
      communityId: (community._id as Types.ObjectId).toString(),
      channelType: 'fc',
      matchedBy: 'name',
    });
  });

  it('matches an FC doc with a captured owner by owner, even when the live name has drifted', async () => {
    const community = await Community.create({ name: 'Ardy Hosts', ownerIds: [new Types.ObjectId()], memberUserIds: [] });
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Old FC Name',
      normalizedName: 'old fc name',
      ownerName: 'Woox',
      normalizedOwnerName: 'woox',
    });

    const binding = await resolveChatBinding('Brand New Name', 'fc', 'Woox');
    expect(binding).toEqual({
      communityId: (community._id as Types.ObjectId).toString(),
      channelType: 'fc',
      matchedBy: 'owner',
    });
  });

  it('does not fall back to name matching for an FC that has already captured an owner', async () => {
    const community = await Community.create({ name: 'Ardy Hosts', ownerIds: [new Types.ObjectId()], memberUserIds: [] });
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
      ownerName: 'Woox',
      normalizedOwnerName: 'woox',
    });

    // Same (now-stale) name, but claiming a different owner — must not resolve by the leftover
    // name field once owner-based trust has taken over.
    expect(await resolveChatBinding('Ardy Splash', 'fc', 'SomeoneElse')).toBeNull();
    // No owner on the message at all.
    expect(await resolveChatBinding('Ardy Splash', 'fc', undefined)).toBeNull();
  });

  it('still requires an exact owner match — a different owner claiming the same live name is unrecognized', async () => {
    await Community.create({ name: 'Ardy Hosts', ownerIds: [new Types.ObjectId()], memberUserIds: [] }).then((community) =>
      ChatChannelName.create({
        communityId: community._id,
        channelType: 'fc',
        ownerName: 'Woox',
        normalizedOwnerName: 'woox',
      }),
    );

    expect(await resolveChatBinding('Whatever Name', 'fc', 'Zezima')).toBeNull();
  });
});

describe('handleChatRelayPayload — Friends Chat identity sync', () => {
  it('captures the owner off the first message that still matches by name', async () => {
    const community = await Community.create({ name: 'Ardy Hosts', ownerIds: [new Types.ObjectId()], memberUserIds: [] });
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
    });

    const result = await handleChatRelayPayload(makeFullModeMessage(), '1.2.3.4');
    expect(result.status).toBe('forwarded');

    const doc = await ChatChannelName.findOne({ communityId: community._id, channelType: 'fc' }).lean();
    expect(doc?.ownerName).toBe('Woox');
    expect(doc?.normalizedOwnerName).toBe('woox');
    // Capturing the owner must not disturb the (still-current) name.
    expect(doc?.name).toBe('Ardy Splash');
  });

  it('does not overwrite an already-captured owner from a later name-matched message', async () => {
    const community = await Community.create({ name: 'Ardy Hosts', ownerIds: [new Types.ObjectId()], memberUserIds: [] });
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
      ownerName: 'Woox',
      normalizedOwnerName: 'woox',
    });

    // A message claiming a different owner cannot resolve at all once one is on file (see
    // resolveChatBinding tests above), so this is really exercising that the capture branch is
    // unreachable for an already-migrated doc — nothing to overwrite.
    await handleChatRelayPayload(makeFullModeMessage({ friendsChat: { name: 'Ardy Splash', owner: 'Woox' } }), '1.2.3.4');

    const doc = await ChatChannelName.findOne({ communityId: community._id, channelType: 'fc' }).lean();
    expect(doc?.ownerName).toBe('Woox');
  });

  it('self-heals the registered name once the FC has been renamed in-game', async () => {
    const community = await Community.create({
      name: 'Ardy Hosts',
      ownerIds: [new Types.ObjectId()],
      memberUserIds: [],
    });
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      name: 'Old FC Name',
      normalizedName: 'old fc name',
      ownerName: 'Woox',
      normalizedOwnerName: 'woox',
    });

    const result = await handleChatRelayPayload(
      makeFullModeMessage({ friendsChat: { name: 'Brand New Name', owner: 'Woox' } }),
      '1.2.3.4',
    );
    expect(result).toEqual({ status: 'forwarded', communityId: (community._id as Types.ObjectId).toString(), channelType: 'fc' });

    const doc = await ChatChannelName.findOne({ communityId: community._id, channelType: 'fc' }).lean();
    expect(doc?.name).toBe('Brand New Name');
    expect(doc?.normalizedName).toBe('brand new name');
    // The owner registration itself is untouched by a rename.
    expect(doc?.ownerName).toBe('Woox');
  });

  it('a community registered by owner only (no message relayed yet) has no name until one arrives', async () => {
    const community = await Community.create({ name: 'Ardy Hosts', ownerIds: [new Types.ObjectId()], memberUserIds: [] });
    await ChatChannelName.create({
      communityId: community._id,
      channelType: 'fc',
      ownerName: 'Woox',
      normalizedOwnerName: 'woox',
    });

    let doc = await ChatChannelName.findOne({ communityId: community._id, channelType: 'fc' }).lean();
    expect(doc?.name).toBeUndefined();

    const result = await handleChatRelayPayload(makeFullModeMessage({ friendsChat: { name: 'Ardy Splash', owner: 'Woox' } }), '1.2.3.4');
    expect(result.status).toBe('forwarded');

    doc = await ChatChannelName.findOne({ communityId: community._id, channelType: 'fc' }).lean();
    expect(doc?.name).toBe('Ardy Splash');
  });
});
