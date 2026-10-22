import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { LinkPreviewCache } from '../../models/LinkPreviewCache';

beforeAll(async () => {
  await connectTestDB();
  await LinkPreviewCache.init();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
});

describe('LinkPreviewCache model', () => {
  it('has a TTL index on expiresAt', async () => {
    const indexes = await LinkPreviewCache.collection.indexes();
    const ttl = indexes.find((i: { expireAfterSeconds?: number }) => i.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect(ttl!.expireAfterSeconds).toBe(0);
  });

  it('enforces one document per sourceType+key', async () => {
    await LinkPreviewCache.create({
      sourceType: 'wiki',
      key: 'Rune_scimitar',
      found: true,
      data: { title: 'Rune scimitar', canonicalUrl: 'https://oldschool.runescape.wiki/w/Rune_scimitar' },
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      LinkPreviewCache.create({
        sourceType: 'wiki',
        key: 'Rune_scimitar',
        found: true,
        data: { title: 'Rune scimitar', canonicalUrl: 'https://oldschool.runescape.wiki/w/Rune_scimitar' },
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow();
  });

  it('allows the same key across different sourceTypes', async () => {
    await LinkPreviewCache.create({
      sourceType: 'wiki',
      key: 'abc123',
      found: false,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      LinkPreviewCache.create({
        sourceType: 'discord-invite',
        key: 'abc123',
        found: false,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toBeDefined();
  });
});
