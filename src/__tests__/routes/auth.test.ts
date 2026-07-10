import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';

const app = createTestApp();
const JWT_SECRET = 'test-jwt-secret';
const SETUP_LINK_SECRET = 'test-setup-secret';

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
});

describe('POST /api/auth/login', () => {
  it('returns 400 when username or password missing', async () => {
    await request(app).post('/api/auth/login').send({}).expect(400);
    await request(app).post('/api/auth/login').send({ username: 'alice' }).expect(400);
    await request(app).post('/api/auth/login').send({ password: 'secret' }).expect(400);
  });

  it('returns 401 for non-existent user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'pass' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for wrong password', async () => {
    const hash = await bcrypt.hash('correct', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('returns a JWT on valid credentials', async () => {
    const hash = await bcrypt.hash('correct', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'correct' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    const payload = jwt.verify(res.body.token, JWT_SECRET) as { sub: string; isAdmin: boolean };
    expect(payload.sub).toBe('alice');
    expect(payload.isAdmin).toBe(false);
  });

  it('returns isAdmin true for admin user', async () => {
    const hash = await bcrypt.hash('pass', 12);
    await User.create({ username: 'admin', passwordHash: hash, token: 'tok2', isAdmin: true, setupLinkUsed: true });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'pass' });
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(true);
  });
});

describe('POST /api/auth/setup/:setupToken', () => {
  function makeSetupToken(username: string, expiresIn: '1h' | '-1s' = '1h') {
    return jwt.sign({ purpose: 'account-setup', username }, SETUP_LINK_SECRET, { expiresIn });
  }

  it('returns 400 for missing or short password', async () => {
    const hash = await bcrypt.hash('placeholder', 12);
    await User.create({ username: 'bob', passwordHash: hash, token: 'tok3', isAdmin: false, setupLinkUsed: false });
    const token = makeSetupToken('bob');

    await request(app).post(`/api/auth/setup/${token}`).send({}).expect(400);
    await request(app).post(`/api/auth/setup/${token}`).send({ password: 'short' }).expect(400);
  });

  it('returns 400 for expired token', async () => {
    const hash = await bcrypt.hash('placeholder', 12);
    await User.create({ username: 'bob', passwordHash: hash, token: 'tok3', isAdmin: false, setupLinkUsed: false });
    const expiredToken = makeSetupToken('bob', '-1s');

    const res = await request(app).post(`/api/auth/setup/${expiredToken}`).send({ password: 'validpass123' });
    expect(res.status).toBe(400);
  });

  it('returns 400 if link already used', async () => {
    const hash = await bcrypt.hash('placeholder', 12);
    await User.create({ username: 'bob', passwordHash: hash, token: 'tok3', isAdmin: false, setupLinkUsed: true });
    const token = makeSetupToken('bob');

    const res = await request(app).post(`/api/auth/setup/${token}`).send({ password: 'validpass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already been used/i);
  });

  it('sets password and marks link used on success', async () => {
    const hash = await bcrypt.hash('placeholder', 12);
    await User.create({ username: 'bob', passwordHash: hash, token: 'tok3', isAdmin: false, setupLinkUsed: false });
    const token = makeSetupToken('bob');

    const res = await request(app).post(`/api/auth/setup/${token}`).send({ password: 'validpass123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();

    const user = await User.findOne({ username: 'bob' });
    expect(user?.setupLinkUsed).toBe(true);
    const match = await bcrypt.compare('validpass123', user!.passwordHash);
    expect(match).toBe(true);
  });
});
