import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { User } from '../../models/User';
import { Community } from '../../models/Community';
import { ArchivedSession } from '../../models/ArchivedSession';
import { BankTicket } from '../../models/BankTicket';
import { computeTotalEarnedGp, computeTotalPaidOutGp } from '../../services/income';
import { makeSessionData } from '../fixtures';

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
});

async function createUser(username: string) {
  return User.create({
    username,
    passwordHash: 'hash',
    token: `token-${username}`,
    isAdmin: false,
    setupLinkUsed: true,
  });
}

describe('computeTotalEarnedGp', () => {
  it('sums hours * hourlyRate across every session, scoped to one community', async () => {
    const owner = await createUser('owner');
    const splasher = await createUser('splasher');
    const communityA = await Community.create({ name: 'A', ownerIds: [owner._id], memberUserIds: [splasher._id] });
    const communityB = await Community.create({ name: 'B', ownerIds: [owner._id], memberUserIds: [splasher._id] });

    // 2-hour session at 100gp/hr in community A, 1-hour session at 50gp/hr in community A,
    // and a 3-hour session at 1000gp/hr in community B — must not bleed into A's total.
    await ArchivedSession.create({
      sessionId: 's1',
      createdTimestamp: 0,
      finalizedTimestamp: 2 * 3_600_000,
      userId: splasher._id,
      username: 'splasher',
      session: makeSessionData(),
      earningsSnapshot: new Map([[communityA._id.toString(), { rankId: owner._id, rankName: 'Default', hourlyRate: 100 }]]),
    });
    await ArchivedSession.create({
      sessionId: 's2',
      createdTimestamp: 3 * 3_600_000,
      finalizedTimestamp: 4 * 3_600_000,
      userId: splasher._id,
      username: 'splasher',
      session: makeSessionData(),
      earningsSnapshot: new Map([[communityA._id.toString(), { rankId: owner._id, rankName: 'Default', hourlyRate: 50 }]]),
    });
    await ArchivedSession.create({
      sessionId: 's3',
      createdTimestamp: 5 * 3_600_000,
      finalizedTimestamp: 8 * 3_600_000,
      userId: splasher._id,
      username: 'splasher',
      session: makeSessionData(),
      earningsSnapshot: new Map([[communityB._id.toString(), { rankId: owner._id, rankName: 'Default', hourlyRate: 1000 }]]),
    });

    const totalA = await computeTotalEarnedGp(splasher._id, communityA._id);
    expect(totalA).toBe(2 * 100 + 1 * 50);

    const totalB = await computeTotalEarnedGp(splasher._id, communityB._id);
    expect(totalB).toBe(3 * 1000);
  });

  it('returns 0 for a user with no sessions', async () => {
    const splasher = await createUser('lonely');
    const community = await Community.create({ name: 'Empty', ownerIds: [splasher._id], memberUserIds: [] });
    expect(await computeTotalEarnedGp(splasher._id, community._id)).toBe(0);
  });
});

describe('computeTotalPaidOutGp', () => {
  it('only counts completed payout tickets, not pending/rejected ones or other ticket types', async () => {
    const owner = await createUser('owner');
    const splasher = await createUser('splasher');
    const community = await Community.create({ name: 'C', ownerIds: [owner._id], memberUserIds: [splasher._id] });

    await BankTicket.create({
      communityId: community._id,
      type: 'payout',
      amountGp: 1_000_000,
      status: 'completed',
      requestedByUserId: splasher._id,
      requestedByUsername: 'splasher',
      requestedByDiscordId: 'discord-1',
    });
    await BankTicket.create({
      communityId: community._id,
      type: 'payout',
      amountGp: 500_000,
      status: 'pending',
      requestedByUserId: splasher._id,
      requestedByUsername: 'splasher',
      requestedByDiscordId: 'discord-1',
    });
    await BankTicket.create({
      communityId: community._id,
      type: 'payout',
      amountGp: 250_000,
      status: 'rejected',
      requestedByUserId: splasher._id,
      requestedByUsername: 'splasher',
      requestedByDiscordId: 'discord-1',
    });
    await BankTicket.create({
      communityId: community._id,
      type: 'deposit',
      amountGp: 999_999,
      status: 'completed',
      requestedByUserId: splasher._id,
      requestedByUsername: 'splasher',
      requestedByDiscordId: 'discord-1',
    });

    expect(await computeTotalPaidOutGp(splasher._id, community._id)).toBe(1_000_000);
  });
});
