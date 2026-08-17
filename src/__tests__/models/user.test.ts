import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { User } from '../../models/User';

beforeAll(async () => {
  await connectTestDB();
  await User.init(); // build indexes (incl. the new sparse unique email index) before asserting on them
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
});

describe('User model — email fields', () => {
  it('allows multiple users with no email set (sparse unique index)', async () => {
    await User.create({ username: 'alice', passwordHash: 'x', token: 'tok1', isAdmin: false, setupLinkUsed: true });
    await User.create({ username: 'bob', passwordHash: 'x', token: 'tok2', isAdmin: false, setupLinkUsed: true });
    expect(await User.countDocuments({})).toBe(2);
  });

  it('rejects a second user with the same email', async () => {
    await User.create({
      username: 'alice', passwordHash: 'x', token: 'tok1', isAdmin: false, setupLinkUsed: true,
      email: 'shared@example.com',
    });
    await expect(
      User.create({
        username: 'bob', passwordHash: 'x', token: 'tok2', isAdmin: false, setupLinkUsed: true,
        email: 'shared@example.com',
      }),
    ).rejects.toThrow(/duplicate key|E11000/);
  });

  it('defaults tokenVersion to 0', async () => {
    const user = await User.create({ username: 'alice', passwordHash: 'x', token: 'tok1', isAdmin: false, setupLinkUsed: true });
    expect(user.tokenVersion).toBe(0);
  });
});
