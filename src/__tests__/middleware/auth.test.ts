import request from 'supertest';
import bcrypt from 'bcryptjs';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';

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

describe('requireAuth — tokenVersion invalidation', () => {
  it('accepts a freshly-issued token', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });

    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: 'password123' });
    expect(login.status).toBe(200);

    const res = await request(app).get('/api/splashers/alice').set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a token issued before a tokenVersion bump', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });

    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: 'password123' });
    expect(login.status).toBe(200);

    // Simulate what a password reset will do in Task 7, independent of that endpoint.
    await User.updateOne({ username: 'alice' }, { $inc: { tokenVersion: 1 } });

    const res = await request(app).get('/api/splashers/alice').set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token for a user that no longer exists', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });

    const login = await request(app).post('/api/auth/login').send({ username: 'alice', password: 'password123' });
    expect(login.status).toBe(200);

    await User.deleteOne({ username: 'alice' });

    const res = await request(app).get('/api/splashers/alice').set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(401);
  });
});
