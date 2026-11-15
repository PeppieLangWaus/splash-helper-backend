import request from 'supertest';
import jwt from 'jsonwebtoken';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';
import { ArchivedSession } from '../../models/ArchivedSession';
import { makeSplashEntry } from '../fixtures';

const app = createTestApp();
const JWT_SECRET = process.env.JWT_SECRET!;

// Prevent actual Discord webhook calls during tests
jest.mock('../../services/discordWebhook', () => ({
  enqueueWebhookNotification: jest.fn(),
}));

function makeToken(username: string, isAdmin = false) {
  return jwt.sign({ sub: username, isAdmin }, JWT_SECRET, { expiresIn: '1h' });
}

async function createUser(username: string, isAdmin = false) {
  return User.create({
    username,
    passwordHash: 'irrelevant',
    token: `token-${username}`,
    isAdmin,
    setupLinkUsed: true,
  });
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

describe('POST /api/sessions/upload', () => {
  let adminToken: string;

  beforeEach(async () => {
    await createUser('admin', true);
    adminToken = makeToken('admin', true);
  });

  function uploadAs(token: string) {
    return request(app).post('/api/sessions/upload').set('Authorization', `Bearer ${token}`);
  }

  it('rejects unauthenticated requests', async () => {
    await request(app).post('/api/sessions/upload').send([makeSplashEntry()]).expect(401);
  });

  it('returns 400 for non-array body', async () => {
    await uploadAs(adminToken).send({ foo: 'bar' }).expect(400);
    await uploadAs(adminToken).send([]).expect(400);
  });

  it('returns 400 for empty array', async () => {
    await uploadAs(adminToken).send([]).expect(400);
  });

  it('skips entries missing required fields', async () => {
    const res = await uploadAs(adminToken).send([{ notASession: true }]);
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(0);
    expect(res.body.skipped).toBe(1);
  });

  it('as admin, adds a valid session and creates user if not exists', async () => {
    const entry = makeSplashEntry();
    const res = await uploadAs(adminToken).send([entry]);
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(1);
    expect(res.body.skipped).toBe(0);

    const user = await User.findOne({ username: entry.session.playerName });
    expect(user).not.toBeNull();

    const stored = await ArchivedSession.findOne({ username: entry.session.playerName });
    expect(stored).not.toBeNull();
  });

  it('as regular user, adds sessions for their own username', async () => {
    await createUser('TestPlayer');
    const entry = makeSplashEntry();

    const res = await uploadAs(makeToken('TestPlayer')).send([entry]);
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(1);

    const stored = await ArchivedSession.findOne({ username: 'TestPlayer' });
    expect(stored).not.toBeNull();
  });

  it('as regular user, skips entries for other usernames without creating users', async () => {
    await createUser('TestPlayer');
    const own = makeSplashEntry();
    const other = makeSplashEntry({
      session: { ...makeSplashEntry().session, playerName: 'SomeoneElse' },
      sessionId: 'sid-other',
      createdTimestamp: Date.now() + 1,
    });

    const res = await uploadAs(makeToken('TestPlayer')).send([own, other]);
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(1);
    expect(res.body.skipped).toBe(1);

    expect(await User.findOne({ username: 'SomeoneElse' })).toBeNull();
    expect(await ArchivedSession.findOne({ username: 'SomeoneElse' })).toBeNull();
  });

  it('deduplicates sessions with same createdTimestamp + finalizedTimestamp', async () => {
    const entry = makeSplashEntry({ createdTimestamp: 1000, finalizedTimestamp: 1000 + 20 * 60_000 });

    const res1 = await uploadAs(adminToken).send([entry]);
    expect(res1.body.added).toBe(1);

    const res2 = await uploadAs(adminToken).send([entry]);
    expect(res2.body.added).toBe(0);
    expect(res2.body.skipped).toBe(1);

    const count = await ArchivedSession.countDocuments({ username: entry.session.playerName });
    expect(count).toBe(1);
  });

  it('handles multiple entries from different players', async () => {
    const e1 = makeSplashEntry({ session: { ...makeSplashEntry().session, playerName: 'Alpha' }, sessionId: 'sid-a' });
    const e2 = makeSplashEntry({ session: { ...makeSplashEntry().session, playerName: 'Beta' }, sessionId: 'sid-b', createdTimestamp: Date.now() + 1 });

    const res = await uploadAs(adminToken).send([e1, e2]);
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(2);
  });

  it('handles a mix of valid and invalid entries', async () => {
    const valid = makeSplashEntry();
    const invalid = { notASession: true };

    const res = await uploadAs(adminToken).send([valid, invalid]);
    expect(res.body.added).toBe(1);
    expect(res.body.skipped).toBe(1);
  });
});
