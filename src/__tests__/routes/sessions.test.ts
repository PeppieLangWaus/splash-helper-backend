import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';
import { ArchivedSession } from '../../models/ArchivedSession';
import { makeSplashEntry } from '../fixtures';

const app = createTestApp();

// Prevent actual Discord webhook calls during tests
jest.mock('../../services/discordWebhook', () => ({
  enqueueWebhookNotification: jest.fn(),
}));

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
  it('returns 400 for non-array body', async () => {
    await request(app).post('/api/sessions/upload').send({ foo: 'bar' }).expect(400);
    await request(app).post('/api/sessions/upload').send([]).expect(400);
  });

  it('returns 400 for empty array', async () => {
    await request(app).post('/api/sessions/upload').send([]).expect(400);
  });

  it('skips entries missing required fields', async () => {
    const res = await request(app)
      .post('/api/sessions/upload')
      .send([{ notASession: true }]);
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(0);
    expect(res.body.skipped).toBe(1);
  });

  it('adds a valid session and creates user if not exists', async () => {
    const entry = makeSplashEntry();
    const res = await request(app).post('/api/sessions/upload').send([entry]);
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(1);
    expect(res.body.skipped).toBe(0);

    const user = await User.findOne({ username: entry.session.playerName });
    expect(user).not.toBeNull();

    const stored = await ArchivedSession.findOne({ username: entry.session.playerName });
    expect(stored).not.toBeNull();
  });

  it('deduplicates sessions with same createdTimestamp + finalizedTimestamp', async () => {
    const entry = makeSplashEntry({ createdTimestamp: 1000, finalizedTimestamp: 2000 });

    const res1 = await request(app).post('/api/sessions/upload').send([entry]);
    expect(res1.body.added).toBe(1);

    const res2 = await request(app).post('/api/sessions/upload').send([entry]);
    expect(res2.body.added).toBe(0);
    expect(res2.body.skipped).toBe(1);

    const count = await ArchivedSession.countDocuments({ username: entry.session.playerName });
    expect(count).toBe(1);
  });

  it('handles multiple entries from different players', async () => {
    const e1 = makeSplashEntry({ session: { ...makeSplashEntry().session, playerName: 'Alpha' }, sessionId: 'sid-a' });
    const e2 = makeSplashEntry({ session: { ...makeSplashEntry().session, playerName: 'Beta' }, sessionId: 'sid-b', createdTimestamp: Date.now() + 1 });

    const res = await request(app).post('/api/sessions/upload').send([e1, e2]);
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(2);
  });

  it('handles a mix of valid and invalid entries', async () => {
    const valid = makeSplashEntry();
    const invalid = { notASession: true };

    const res = await request(app).post('/api/sessions/upload').send([valid, invalid]);
    expect(res.body.added).toBe(1);
    expect(res.body.skipped).toBe(1);
  });
});
