import { ChatChannelName, syncChatChannelNameIndexes } from '../../models/ChatChannelName';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';

describe('ChatChannelName index creation', () => {
  beforeAll(async () => {
    await connectTestDB();
  });

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearCollections();
  });

  it('creates the partial unique indexes without error, even against pre-existing legacy docs', async () => {
    // Simulate legacy docs written before nameTrustEligible existed, inserted directly (bypassing
    // the app's own write paths, and the schema's default value) to mimic real production data.
    await ChatChannelName.collection.insertMany([
      {
        communityId: new (require('mongoose').Types.ObjectId)(),
        channelType: 'cc',
        name: 'Legacy CC',
        normalizedName: 'legacy cc',
      },
      {
        communityId: new (require('mongoose').Types.ObjectId)(),
        channelType: 'fc',
        name: 'Legacy FC',
        normalizedName: 'legacy fc',
      },
      {
        communityId: new (require('mongoose').Types.ObjectId)(),
        channelType: 'fc',
        ownerName: 'SomeOwner',
        normalizedOwnerName: 'someowner',
      },
    ]);

    await expect(syncChatChannelNameIndexes()).resolves.not.toThrow();

    const indexes: Array<{ name?: string; unique?: boolean }> = await ChatChannelName.collection.indexes();
    const nameIdx = indexes.find((i) => i.name === 'normalizedName_1_channelType_1');
    expect(nameIdx).toBeDefined();
    expect(nameIdx?.unique).toBe(true);

    // Backfill actually ran.
    const legacyCc = await ChatChannelName.findOne({ normalizedName: 'legacy cc' }).lean();
    expect(legacyCc?.nameTrustEligible).toBe(true);
  });
});
