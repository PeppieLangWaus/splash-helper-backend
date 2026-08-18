import { Types } from 'mongoose';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { PasswordResetToken } from '../../models/PasswordResetToken';
import { EmailVerificationToken } from '../../models/EmailVerificationToken';

beforeAll(async () => {
  await connectTestDB();
  await PasswordResetToken.init();
  await EmailVerificationToken.init();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
});

describe('PasswordResetToken model', () => {
  it('defaults requestedByAdmin to false', async () => {
    const doc = await PasswordResetToken.create({
      userId: new Types.ObjectId(),
      tokenHash: 'abc123',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    expect(doc.requestedByAdmin).toBe(false);
  });

  it('has a TTL index on expiresAt', async () => {
    const indexes = await PasswordResetToken.collection.indexes();
    const ttl = indexes.find((i: { expireAfterSeconds?: number }) => i.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect(ttl!.expireAfterSeconds).toBe(0);
  });
});

describe('EmailVerificationToken model', () => {
  it('ties a token to a user', async () => {
    const userId = new Types.ObjectId();
    const doc = await EmailVerificationToken.create({
      userId,
      tokenHash: 'def456',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    expect(doc.userId.toString()).toBe(userId.toString());
  });

  it('has a TTL index on expiresAt', async () => {
    const indexes = await EmailVerificationToken.collection.indexes();
    const ttl = indexes.find((i: { expireAfterSeconds?: number }) => i.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect(ttl!.expireAfterSeconds).toBe(0);
  });
});
