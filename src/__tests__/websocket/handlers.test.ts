import { WebSocket } from 'ws';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { User } from '../../models/User';
import { ArchivedSession } from '../../models/ArchivedSession';
import { makeSessionData } from '../fixtures';
import * as sessionManager from '../../websocket/sessionManager';
import { handleMessage } from '../../websocket/handlers';

// Prevent actual Discord calls
jest.mock('../../services/discordWebhook', () => ({
  enqueueWebhookNotification: jest.fn(),
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

  lastMessage() {
    return JSON.parse(this.sent[this.sent.length - 1]);
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
  sessionManager.getAll().forEach((s) => sessionManager.remove(s.username));
});

describe('WebSocket AUTH handler', () => {
  it('AUTH_FAILURE when username or token missing', async () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleMessage(ws, JSON.stringify({ type: 'AUTH', username: '', token: '' }));
    const msg = (ws as unknown as MockWebSocket).lastMessage();
    expect(msg.type).toBe('AUTH_FAILURE');
  });

  it('creates new user and returns AUTH_SUCCESS with setup link', async () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleMessage(ws, JSON.stringify({ type: 'AUTH', username: 'NewPlayer', token: 'uuid-123' }));
    const msg = (ws as unknown as MockWebSocket).lastMessage();
    expect(msg.type).toBe('AUTH_SUCCESS');
    expect(msg.setupRequired).toBe(true);
    expect(msg.setupLink).toBeDefined();

    const user = await User.findOne({ username: 'NewPlayer' });
    expect(user).not.toBeNull();
    expect(user!.token).toBe('uuid-123');
  });

  it('AUTH_FAILURE for existing user with wrong token', async () => {
    await User.create({
      username: 'Existing',
      passwordHash: 'hash',
      token: 'correct-token',
      isAdmin: false,
      setupLinkUsed: false,
    });

    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleMessage(ws, JSON.stringify({ type: 'AUTH', username: 'Existing', token: 'wrong-token' }));
    const msg = (ws as unknown as MockWebSocket).lastMessage();
    expect(msg.type).toBe('AUTH_FAILURE');
  });

  it('AUTH_SUCCESS for existing user with correct token, no setup link if already set up', async () => {
    await User.create({
      username: 'Existing',
      passwordHash: 'hash',
      token: 'correct-token',
      isAdmin: false,
      setupLinkUsed: true,
    });

    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleMessage(ws, JSON.stringify({ type: 'AUTH', username: 'Existing', token: 'correct-token' }));
    const msg = (ws as unknown as MockWebSocket).lastMessage();
    expect(msg.type).toBe('AUTH_SUCCESS');
    expect(msg.setupRequired).toBe(false);
    expect(msg.setupLink).toBeUndefined();
  });
});

describe('WebSocket session lifecycle', () => {
  async function authenticatePlayer(username: string, token: string) {
    await User.create({
      username,
      passwordHash: 'hash',
      token,
      isAdmin: false,
      setupLinkUsed: true,
    });
    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleMessage(ws, JSON.stringify({ type: 'AUTH', username, token }));
    return ws;
  }

  it('rejects SESSION_START without prior AUTH', async () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData: makeSessionData() }));
    const msg = (ws as unknown as MockWebSocket).lastMessage();
    expect(msg.type).toBe('AUTH_FAILURE');
  });

  it('handles SESSION_START and stores session data', async () => {
    const ws = await authenticatePlayer('SplashKing', 'tok-1');
    const sessionData = makeSessionData({ playerName: 'SplashKing' });
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData }));

    const mock = ws as unknown as MockWebSocket;
    expect(mock.lastMessage().type).toBe('ACK');

    const state = sessionManager.get('SplashKing');
    expect(state?.sessionData).not.toBeNull();
    expect(state?.sessionData?.playerName).toBe('SplashKing');
  });

  it('handles SESSION_UPDATE and updates in-memory state', async () => {
    const ws = await authenticatePlayer('SplashKing', 'tok-1');
    const initial = makeSessionData({ playerName: 'SplashKing', spellsCast: 100 });
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData: initial }));

    const updated = makeSessionData({ playerName: 'SplashKing', spellsCast: 500 });
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_UPDATE', sessionData: updated }));

    const state = sessionManager.get('SplashKing');
    expect(state?.sessionData?.spellsCast).toBe(500);
  });

  it('handles SESSION_END, archives to DB, and removes from active sessions', async () => {
    const ws = await authenticatePlayer('SplashKing', 'tok-1');
    const sessionData = makeSessionData({ playerName: 'SplashKing' });
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_START', sessionData }));
    await handleMessage(ws, JSON.stringify({ type: 'SESSION_END', sessionData }));

    const mock = ws as unknown as MockWebSocket;
    expect(mock.lastMessage().type).toBe('ACK');

    // Should no longer be in active sessions
    expect(sessionManager.get('SplashKing')).toBeUndefined();

    // Should be archived in DB
    const archived = await ArchivedSession.findOne({ username: 'SplashKing' });
    expect(archived).not.toBeNull();
  });

  it('sends AUTH_FAILURE for invalid JSON', async () => {
    const ws = new MockWebSocket() as unknown as WebSocket;
    await handleMessage(ws, 'not-json{{{');
    const msg = (ws as unknown as MockWebSocket).lastMessage();
    expect(msg.type).toBe('AUTH_FAILURE');
  });
});
