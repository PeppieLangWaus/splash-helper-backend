const fetchMock = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).fetch = fetchMock;

import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { getLinkPreview } from '../../services/linkPreview';
import { LinkPreviewCache } from '../../models/LinkPreviewCache';

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
  fetchMock.mockReset();
});

describe('getLinkPreview — unsupported URLs', () => {
  it('returns unsupported for a domain outside the allowlist, without calling fetch', async () => {
    const result = await getLinkPreview('https://example.com/whatever');
    expect(result).toEqual({ type: 'unsupported' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns unsupported for a non-article wiki path', async () => {
    const result = await getLinkPreview('https://oldschool.runescape.wiki/robots.txt');
    expect(result).toEqual({ type: 'unsupported' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getLinkPreview — wiki articles', () => {
  const wikiOkBody = {
    query: {
      pages: {
        '12345': {
          title: 'Rune scimitar',
          extract: 'The rune scimitar is a scimitar degree weapon.',
          thumbnail: { source: 'https://oldschool.runescape.wiki/images/Rune_scimitar.png' },
          fullurl: 'https://oldschool.runescape.wiki/w/Rune_scimitar',
        },
      },
    },
  };

  it('resolves a known page', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, wikiOkBody));

    const result = await getLinkPreview('https://oldschool.runescape.wiki/w/Rune_scimitar');
    expect(result).toEqual({
      type: 'wiki',
      found: true,
      data: {
        title: 'Rune scimitar',
        extract: 'The rune scimitar is a scimitar degree weapon.',
        thumbnailUrl: 'https://oldschool.runescape.wiki/images/Rune_scimitar.png',
        canonicalUrl: 'https://oldschool.runescape.wiki/w/Rune_scimitar',
      },
    });
  });

  it('treats a "missing" page as not found', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { query: { pages: { '-1': { title: 'Not A Real Page', missing: '' } } } }),
    );

    const result = await getLinkPreview('https://oldschool.runescape.wiki/w/Not_A_Real_Page');
    expect(result).toEqual({ type: 'wiki', found: false });
  });

  it('caches a resolved page so a second lookup does not call fetch again', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, wikiOkBody));

    await getLinkPreview('https://oldschool.runescape.wiki/w/Rune_scimitar');
    await getLinkPreview('https://oldschool.runescape.wiki/w/Rune_scimitar');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await LinkPreviewCache.countDocuments({ sourceType: 'wiki', key: 'Rune_scimitar' })).toBe(1);
  });

  it('treats an upstream failure as not found rather than throwing', async () => {
    fetchMock.mockRejectedValue(new Error('network blip'));

    const result = await getLinkPreview('https://oldschool.runescape.wiki/w/Rune_scimitar');
    expect(result).toEqual({ type: 'wiki', found: false });
  });
});

describe('getLinkPreview — Discord invites', () => {
  const inviteOkBody = {
    guild: { id: '111', name: 'Ardy Host', icon: 'abc123', description: 'Splashing community' },
    channel: { name: 'general' },
    approximate_member_count: 500,
    approximate_presence_count: 42,
  };

  it('resolves a valid invite, including a vanity code', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, inviteOkBody));

    const result = await getLinkPreview('https://discord.gg/ardy-host');
    expect(result).toEqual({
      type: 'discord-invite',
      found: true,
      data: {
        guildName: 'Ardy Host',
        guildIconUrl: 'https://cdn.discordapp.com/icons/111/abc123.png?size=128',
        description: 'Splashing community',
        memberCount: 500,
        onlineCount: 42,
        channelName: 'general',
      },
    });
  });

  it('resolves the discord.com/invite/ form', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, inviteOkBody));

    const result = await getLinkPreview('https://discord.com/invite/ardy-host');
    expect(result.type).toBe('discord-invite');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v10/invites/ardy-host'),
      expect.anything(),
    );
  });

  it('treats an unknown/revoked invite (404) as not found', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: 'Unknown Invite', code: 10006 }));

    const result = await getLinkPreview('https://discord.gg/deadinvite');
    expect(result).toEqual({ type: 'discord-invite', found: false });
  });
});
