import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';
import { User } from '../../models/User';
import { EmailVerificationToken } from '../../models/EmailVerificationToken';
import { generateToken } from '../../utils/secureToken';

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

describe('POST /api/auth/reset-password (legacy sync-token route)', () => {
  it('no longer exists at the old bare path', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ username: 'alice', token: 'tok1', newPassword: 'validpass123' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/auth/email', () => {
  function makeAuthToken(username: string) {
    return jwt.sign({ sub: username, isAdmin: false, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
  }

  it('returns 401 without auth', async () => {
    await request(app).post('/api/auth/email').send({ email: 'a@example.com', currentPassword: 'x' }).expect(401);
  });

  it('returns 400 for missing fields', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });
    await request(app)
      .post('/api/auth/email')
      .set('Authorization', `Bearer ${makeAuthToken('alice')}`)
      .send({})
      .expect(400);
  });

  it('returns 400 for an invalid email address', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });
    const res = await request(app)
      .post('/api/auth/email')
      .set('Authorization', `Bearer ${makeAuthToken('alice')}`)
      .send({ email: 'not-an-email', currentPassword: 'password123' });
    expect(res.status).toBe(400);
  });

  it('returns 401 for an incorrect current password', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });
    const res = await request(app)
      .post('/api/auth/email')
      .set('Authorization', `Bearer ${makeAuthToken('alice')}`)
      .send({ email: 'alice@example.com', currentPassword: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('sets the email unverified and creates a verification token', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });
    const res = await request(app)
      .post('/api/auth/email')
      .set('Authorization', `Bearer ${makeAuthToken('alice')}`)
      .send({ email: 'Alice@Example.com', currentPassword: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('alice@example.com');
    expect(res.body.emailVerifiedAt).toBeNull();

    const user = await User.findOne({ username: 'alice' });
    expect(user!.email).toBe('alice@example.com');
    expect(user!.emailVerifiedAt).toBeUndefined();
    expect(await EmailVerificationToken.countDocuments({ userId: user!._id })).toBe(1);
  });

  it('returns 409 when the email is already in use on another account', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({
      username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'taken@example.com', emailVerifiedAt: new Date(),
    });
    await User.create({ username: 'bob', passwordHash: hash, token: 'tok2', isAdmin: false, setupLinkUsed: true });

    const res = await request(app)
      .post('/api/auth/email')
      .set('Authorization', `Bearer ${makeAuthToken('bob')}`)
      .send({ email: 'taken@example.com', currentPassword: 'password123' });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/auth/verify-email/:token', () => {
  it('returns 400 for an unknown token', async () => {
    const res = await request(app).get('/api/auth/verify-email/not-a-real-token');
    expect(res.status).toBe(400);
  });

  it('verifies the email and consumes the token on success', async () => {
    const hash = await bcrypt.hash('password123', 12);
    const user = await User.create({
      username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'alice@example.com',
    });
    const { raw, hash: tokenHash } = generateToken();
    await EmailVerificationToken.create({ userId: user._id, tokenHash, expiresAt: new Date(Date.now() + 60_000) });

    const res = await request(app).get(`/api/auth/verify-email/${raw}`);
    expect(res.status).toBe(200);

    const updated = await User.findOne({ username: 'alice' });
    expect(updated!.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await EmailVerificationToken.countDocuments({ userId: user._id })).toBe(0);
  });

  it('returns 400 for an expired token', async () => {
    const hash = await bcrypt.hash('password123', 12);
    const user = await User.create({
      username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'alice@example.com',
    });
    const { raw, hash: tokenHash } = generateToken();
    await EmailVerificationToken.create({ userId: user._id, tokenHash, expiresAt: new Date(Date.now() - 1000) });

    const res = await request(app).get(`/api/auth/verify-email/${raw}`);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/resend-verification', () => {
  function makeAuthToken(username: string) {
    return jwt.sign({ sub: username, isAdmin: false, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
  }

  it('returns 400 when there is no email on file', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({ username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true });
    const res = await request(app)
      .post('/api/auth/resend-verification')
      .set('Authorization', `Bearer ${makeAuthToken('alice')}`);
    expect(res.status).toBe(400);
  });

  it('returns 400 when the email is already verified', async () => {
    const hash = await bcrypt.hash('password123', 12);
    await User.create({
      username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'alice@example.com', emailVerifiedAt: new Date(),
    });
    const res = await request(app)
      .post('/api/auth/resend-verification')
      .set('Authorization', `Bearer ${makeAuthToken('alice')}`);
    expect(res.status).toBe(400);
  });

  it('issues a fresh token, replacing any previous one', async () => {
    const hash = await bcrypt.hash('password123', 12);
    const user = await User.create({
      username: 'alice', passwordHash: hash, token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'alice@example.com',
    });
    await EmailVerificationToken.create({ userId: user._id, tokenHash: 'stale', expiresAt: new Date(Date.now() + 60_000) });

    const res = await request(app)
      .post('/api/auth/resend-verification')
      .set('Authorization', `Bearer ${makeAuthToken('alice')}`);
    expect(res.status).toBe(200);

    const tokens = await EmailVerificationToken.find({ userId: user._id });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].tokenHash).not.toBe('stale');
  });
});
