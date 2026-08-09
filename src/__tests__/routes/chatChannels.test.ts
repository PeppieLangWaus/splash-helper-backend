import request from 'supertest';
import { Types } from 'mongoose';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { Community } from '../../models/Community';
import { ChatChannelName } from '../../models/ChatChannelName';

const app = createTestApp();

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
});

describe('GET /api/chat-channels', () => {
  it('requires no auth and returns an empty list when nothing is registered', async () => {
    const res = await request(app).get('/api/chat-channels');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channels: [] });
  });

  it('lists communities with registered FC and/or CC names, omitting communities with neither', async () => {
    const withBoth = await Community.create({ name: 'Ardy Hosts', ownerIds: [new Types.ObjectId()], memberUserIds: [] });
    const withOne = await Community.create({ name: 'Solo Splash', ownerIds: [new Types.ObjectId()], memberUserIds: [] });
    await Community.create({ name: 'No Chat Configured', ownerIds: [new Types.ObjectId()], memberUserIds: [] });

    await ChatChannelName.create({
      communityId: withBoth._id,
      channelType: 'fc',
      name: 'Ardy Splash',
      normalizedName: 'ardy splash',
      displayName: 'Ardy Splashers',
    });
    await ChatChannelName.create({
      communityId: withBoth._id,
      channelType: 'cc',
      name: 'Ardy Splash CC',
      normalizedName: 'ardy splash cc',
    });
    await ChatChannelName.create({
      communityId: withOne._id,
      channelType: 'fc',
      name: 'Solo FC',
      normalizedName: 'solo fc',
    });

    const res = await request(app).get('/api/chat-channels');
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(2);

    const byId = new Map(
      (res.body.channels as Array<{ communityId: string }>).map((c) => [c.communityId, c]),
    );
    expect(byId.get((withBoth._id as Types.ObjectId).toString())).toEqual({
      communityId: (withBoth._id as Types.ObjectId).toString(),
      communityName: 'Ardy Hosts',
      friendsChatName: 'Ardy Splash',
      friendsChatDisplayName: 'Ardy Splashers',
      clanChatName: 'Ardy Splash CC',
    });
    expect(byId.get((withOne._id as Types.ObjectId).toString())).toEqual({
      communityId: (withOne._id as Types.ObjectId).toString(),
      communityName: 'Solo Splash',
      friendsChatName: 'Solo FC',
      friendsChatDisplayName: null,
      clanChatName: null,
    });
  });

  it('omits a registration left orphaned by a deleted community', async () => {
    const ghostCommunityId = new Types.ObjectId();
    await ChatChannelName.create({
      communityId: ghostCommunityId,
      channelType: 'fc',
      name: 'Ghost FC',
      normalizedName: 'ghost fc',
    });

    const res = await request(app).get('/api/chat-channels');
    expect(res.body.channels).toEqual([]);
  });
});
