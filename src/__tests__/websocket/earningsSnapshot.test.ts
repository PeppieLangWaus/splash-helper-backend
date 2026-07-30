import { WebSocket } from 'ws';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { User } from '../../models/User';
import { Community } from '../../models/Community';
import { Rank } from '../../models/Rank';
import { ArchivedSession } from '../../models/ArchivedSession';
import { makeSessionData } from '../fixtures';
import { handleMessage } from '../../websocket/handlers';

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
}

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
});

async function authenticatePlayer(username: string, token: string) {
  await User.create({ username, passwordHash: 'hash', token, isAdmin: false, setupLinkUsed: true });
  const ws = new MockWebSocket() as unknown as WebSocket;
  await handleMessage(ws, JSON.stringify({ type: 'AUTH', username, token }));
  return ws;
}

describe('ArchivedSession.earningsSnapshot', () => {
  it('freezes the rank/rate in effect at finalization time, and ignores later rate changes', async () => {
    const owner = await User.create({
      username: 'owner',
      passwordHash: 'hash',
      token: 'owner-tok',
      isAdmin: false,
      setupLinkUsed: true,
    });
    const ws = await authenticatePlayer('SplashKing', 'tok-1');
    const community = await Community.create({ name: 'Splash Squad', ownerIds: [owner._id], memberUserIds: [] });
    const rank = await Rank.create({ communityId: community._id, name: 'Default', hourlyRate: 10, isDefault: true });

    const user = await User.findOne({ username: 'SplashKing' });
    user!.rankAssignments = new Map([[community._id.toString(), rank._id]]);
    await user!.save();
    await Community.updateOne({ _id: community._id }, { $push: { memberUserIds: user!._id } });

    const sessionData = makeSessionData({ playerName: 'SplashKing' });
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData }));
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_END', sessionData }));

    const archived = await ArchivedSession.findOne({ username: 'SplashKing' });
    expect(archived).not.toBeNull();
    const snapshot = archived!.earningsSnapshot?.get(community._id.toString());
    expect(snapshot?.hourlyRate).toBe(10);
    expect(snapshot?.rankName).toBe('Default');

    // Rate changes after the fact — the already-archived session's snapshot must not move.
    rank.hourlyRate = 999;
    await rank.save();

    const reloaded = await ArchivedSession.findOne({ username: 'SplashKing' });
    expect(reloaded!.earningsSnapshot?.get(community._id.toString())?.hourlyRate).toBe(10);
  });

  it('leaves earningsSnapshot empty for a splasher with no community membership', async () => {
    const ws = await authenticatePlayer('Loner', 'tok-2');
    const sessionData = makeSessionData({ playerName: 'Loner' });
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData }));
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_END', sessionData }));

    const archived = await ArchivedSession.findOne({ username: 'Loner' });
    expect(archived).not.toBeNull();
    expect(archived!.earningsSnapshot?.size ?? 0).toBe(0);
  });
});
