const fetchMock = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).fetch = fetchMock;

import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { getLinkPreview } from '../../services/linkPreview';
import { LinkPreviewCache } from '../../models/LinkPreviewCache';

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function textResponse(status: number, body: string) {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
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

  it('returns unsupported for the Plugin Hub listing page itself, not just a show/ page', async () => {
    const result = await getLinkPreview('https://runelite.net/plugin-hub');
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

describe('getLinkPreview — Plugin Hub listings', () => {
  const propertiesBody = 'repository=https://github.com/Zoinkwiz/quest-helper.git\ncommit=94acc617e99fe8029ea62f9b8bceaf1ece0a75ea\n';
  const githubRepoBody = {
    description: 'A helper for questing',
    stargazers_count: 42,
    html_url: 'https://github.com/Zoinkwiz/quest-helper',
    owner: { login: 'Zoinkwiz', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
  };

  it('resolves a known plugin via its GitHub repo', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse(200, propertiesBody))
      .mockResolvedValueOnce(jsonResponse(200, githubRepoBody));

    const result = await getLinkPreview('https://runelite.net/plugin-hub/show/quest-helper');
    expect(result).toEqual({
      type: 'plugin-hub',
      found: true,
      data: {
        displayName: 'Quest Helper',
        author: 'Zoinkwiz',
        description: 'A helper for questing',
        iconUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
        stars: 42,
        repoUrl: 'https://github.com/Zoinkwiz/quest-helper',
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://raw.githubusercontent.com/runelite/plugin-hub/master/plugins/quest-helper',
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/Zoinkwiz/quest-helper',
      expect.anything(),
    );
  });

  it('treats an unknown plugin slug (404 properties file) as not found, without calling GitHub', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(404, '404: Not Found'));

    const result = await getLinkPreview('https://runelite.net/plugin-hub/show/not-a-real-plugin');
    expect(result).toEqual({ type: 'plugin-hub', found: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a disabled (pulled) plugin as not found', async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse(200, 'repository=https://github.com/someone/removed-plugin.git\ncommit=abc\ndisabled=malware\n'),
    );

    const result = await getLinkPreview('https://runelite.net/plugin-hub/show/removed-plugin');
    expect(result).toEqual({ type: 'plugin-hub', found: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a GitHub repo lookup failure (e.g. repo renamed/deleted) as not found', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse(200, propertiesBody))
      .mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' }));

    const result = await getLinkPreview('https://runelite.net/plugin-hub/show/quest-helper');
    expect(result).toEqual({ type: 'plugin-hub', found: false });
  });

  it('caches a resolved plugin so a second lookup does not call fetch again', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse(200, propertiesBody))
      .mockResolvedValueOnce(jsonResponse(200, githubRepoBody));

    await getLinkPreview('https://runelite.net/plugin-hub/show/quest-helper');
    await getLinkPreview('https://runelite.net/plugin-hub/show/quest-helper');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await LinkPreviewCache.countDocuments({ sourceType: 'plugin-hub', key: 'quest-helper' })).toBe(1);
  });
});
