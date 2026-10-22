import { logWarn } from '../utils/logger';
import { LinkPreviewCache, LinkPreviewData, LinkPreviewSourceType } from '../models/LinkPreviewCache';

// Discord-style hover previews for the link types actually pasted into "regular" (non-chat)
// pages on the site — OSRS Wiki articles (guide pages), a community's public Discord invite
// (routes/communities.ts's `discordInviteUrl`, shown e.g. in SessionPanel), and RuneLite Plugin
// Hub listings (also linked from guide pages). Deliberately not general-purpose OpenGraph
// scraping of arbitrary URLs — see the domain allowlist in `parseLinkPreviewSource` below. Every
// result (including "not found") is cached in Mongo (models/LinkPreviewCache.ts) so a link
// hovered by many visitors only ever hits the upstream API once per TTL window, rather than once
// per browser.

const USER_AGENT = 'splash-helper-backend (+https://github.com/PeppieLangWaus/splash-helper-backend)';
const FETCH_TIMEOUT_MS = 4_000;

// Wiki articles change rarely — cache generously. Discord invite metadata (member/online counts,
// and the guild could rename itself) is more of a live-ish snapshot, so it gets a much shorter
// TTL. A Plugin Hub listing's GitHub description/star count drifts slowly, similar in spirit to a
// repo's README, so it sits between the two. Either way a "not found" result gets the shortest
// TTL of all, so a broken/typo'd link self-heals quickly instead of staying cached-broken for
// days.
const WIKI_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DISCORD_INVITE_TTL_MS = 45 * 60 * 1000;
const PLUGIN_HUB_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 60 * 1000;

const WIKI_HOSTNAMES = new Set(['oldschool.runescape.wiki']);
// Mirrors services/discordWebhook.ts's DISCORD_INVITE_URL_PATTERN (kept separate rather than
// imported since that one only validates, it doesn't capture the code) — matches
// discord.gg/<code> and discord(app).com/invite/<code>, including a vanity code like
// discord.gg/some-community-name.
const DISCORD_INVITE_URL_PATTERN =
  /^https:\/\/(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)([\w-]+)\/?$/;
// Matches a Plugin Hub listing page, e.g. https://runelite.net/plugin-hub/show/quest-helper —
// capturing the plugin's internalName (the slug also used as its key in the plugin-hub repo, see
// resolvePluginHub below).
const PLUGIN_HUB_URL_PATTERN = /^https:\/\/runelite\.net\/plugin-hub\/show\/([\w-]+)\/?$/;

export type LinkPreviewResult =
  | { type: 'wiki'; found: true; data: import('../models/LinkPreviewCache').WikiPreviewData }
  | { type: 'discord-invite'; found: true; data: import('../models/LinkPreviewCache').DiscordInvitePreviewData }
  | { type: 'plugin-hub'; found: true; data: import('../models/LinkPreviewCache').PluginHubPreviewData }
  | { type: 'wiki' | 'discord-invite' | 'plugin-hub'; found: false }
  | { type: 'unsupported' };

type LinkSource =
  | { sourceType: 'wiki'; key: string }
  | { sourceType: 'discord-invite'; key: string }
  | { sourceType: 'plugin-hub'; key: string };

/** Figures out which resolver (if any) a given URL belongs to, and the normalized cache key
 *  within it. Returns null for anything outside the allowlist — callers treat that as
 *  `{ type: 'unsupported' }` without making any network call or cache lookup. */
function parseLinkPreviewSource(rawUrl: string): LinkSource | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  if (WIKI_HOSTNAMES.has(url.hostname) && url.pathname.startsWith('/w/')) {
    // Title only — url.pathname already excludes the `#Section` fragment, and MediaWiki accepts
    // either spaces or underscores in `titles=`, so no further normalization is needed here.
    const title = decodeURIComponent(url.pathname.slice('/w/'.length));
    if (!title) return null;
    return { sourceType: 'wiki', key: title };
  }

  const inviteMatch = DISCORD_INVITE_URL_PATTERN.exec(rawUrl);
  if (inviteMatch) {
    return { sourceType: 'discord-invite', key: inviteMatch[1] };
  }

  const pluginHubMatch = PLUGIN_HUB_URL_PATTERN.exec(rawUrl);
  if (pluginHubMatch) {
    return { sourceType: 'plugin-hub', key: pluginHubMatch[1] };
  }

  return null;
}

async function fetchJson(
  url: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: controller.signal });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    logWarn(`Link preview request to ${url} failed: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url: string): Promise<{ status: number; body: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    return { status: res.status, body: await res.text().catch(() => '') };
  } catch (err) {
    logWarn(`Link preview request to ${url} failed: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

interface WikiQueryPage {
  title?: string;
  extract?: string;
  thumbnail?: { source?: string };
  fullurl?: string;
  missing?: unknown;
}

// Tooltip content, not the article — keep it short.
const WIKI_EXTRACT_MAX_LENGTH = 300;

async function resolveWiki(title: string): Promise<LinkPreviewResult> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    titles: title,
    prop: 'extracts|pageimages|info',
    exintro: '1',
    explaintext: '1',
    piprop: 'thumbnail',
    pithumbsize: '300',
    inprop: 'url',
    redirects: '1',
  });

  const res = await fetchJson(`https://oldschool.runescape.wiki/api.php?${params.toString()}`);
  const pages = (res?.body as { query?: { pages?: Record<string, WikiQueryPage> } } | null)?.query?.pages;
  const page = pages ? Object.values(pages)[0] : undefined;

  if (!page || page.missing !== undefined || !page.title || !page.fullurl) {
    return { type: 'wiki', found: false };
  }

  const extract = page.extract?.trim();
  return {
    type: 'wiki',
    found: true,
    data: {
      title: page.title,
      extract: extract ? extract.slice(0, WIKI_EXTRACT_MAX_LENGTH) : undefined,
      thumbnailUrl: page.thumbnail?.source,
      canonicalUrl: page.fullurl,
    },
  };
}

interface DiscordInviteResponse {
  guild?: { id?: string; name?: string; icon?: string | null; description?: string | null };
  channel?: { name?: string };
  approximate_member_count?: number;
  approximate_presence_count?: number;
}

function guildIconUrl(guildId: string, icon: string): string {
  return `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=128`;
}

async function resolveDiscordInvite(code: string): Promise<LinkPreviewResult> {
  const params = new URLSearchParams({ with_counts: 'true', with_expiration: 'true' });
  const res = await fetchJson(`https://discord.com/api/v10/invites/${encodeURIComponent(code)}?${params.toString()}`);

  if (!res || res.status !== 200) {
    return { type: 'discord-invite', found: false };
  }

  const body = res.body as DiscordInviteResponse;
  if (!body.guild?.id || !body.guild?.name) {
    return { type: 'discord-invite', found: false };
  }

  return {
    type: 'discord-invite',
    found: true,
    data: {
      guildName: body.guild.name,
      guildIconUrl: body.guild.icon ? guildIconUrl(body.guild.id, body.guild.icon) : undefined,
      description: body.guild.description ?? undefined,
      memberCount: body.approximate_member_count,
      onlineCount: body.approximate_presence_count,
      channelName: body.channel?.name,
    },
  };
}

// The plugin-hub repo (github.com/runelite/plugin-hub) stores one `plugins/<internalName>`
// properties file per listed plugin — just `repository=<git url>` and `commit=<sha>` (plus an
// optional `disabled` flag for pulled plugins), not the display name/description/icon shown on
// the hub page itself. Those come from RuneLite's own versioned plugin manifest, which is
// impractical to depend on here (needs the current client version, and is a large custom binary
// format). Instead this reads the properties file for the plugin's GitHub repo, then asks GitHub's
// API for that repo's own description/owner avatar/star count — not identical to the Plugin Hub's
// listing copy, but the same idea, and a stable public API.
const PLUGIN_HUB_PROPERTIES_BASE = 'https://raw.githubusercontent.com/runelite/plugin-hub/master/plugins/';
const GITHUB_API_BASE = 'https://api.github.com/repos/';

interface GitHubRepoResponse {
  description?: string | null;
  stargazers_count?: number;
  html_url?: string;
  owner?: { login?: string; avatar_url?: string };
}

/** `quest-helper` -> `Quest Helper`. Not always identical to the plugin's real display name (e.g.
 *  an all-lowercase or acronym one like `117hd`), but a reasonable stand-in — the internalName is
 *  the only name we have without depending on RuneLite's own plugin manifest (see above). */
function humanizePluginSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

async function resolvePluginHub(slug: string): Promise<LinkPreviewResult> {
  const propsRes = await fetchText(`${PLUGIN_HUB_PROPERTIES_BASE}${encodeURIComponent(slug)}`);
  if (!propsRes || propsRes.status !== 200) {
    return { type: 'plugin-hub', found: false };
  }

  let repository = '';
  let disabled = false;
  for (const line of propsRes.body.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'repository') repository = value;
    else if (key === 'disabled') disabled = true;
  }
  if (!repository || disabled) {
    return { type: 'plugin-hub', found: false };
  }

  // repository is e.g. "https://github.com/Zoinkwiz/quest-helper.git".
  const repoPathParts = repository.replace(/^https?:\/\//, '').replace(/\.git$/, '').split('/');
  if (repoPathParts.length < 3) return { type: 'plugin-hub', found: false };
  const [, owner, repo] = repoPathParts;

  const repoRes = await fetchJson(`${GITHUB_API_BASE}${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    Accept: 'application/vnd.github+json',
  });
  if (!repoRes || repoRes.status !== 200) {
    return { type: 'plugin-hub', found: false };
  }

  const repoBody = repoRes.body as GitHubRepoResponse;
  return {
    type: 'plugin-hub',
    found: true,
    data: {
      displayName: humanizePluginSlug(slug),
      author: repoBody.owner?.login || owner,
      description: repoBody.description ?? undefined,
      iconUrl: repoBody.owner?.avatar_url,
      stars: repoBody.stargazers_count,
      repoUrl: repoBody.html_url || `https://github.com/${owner}/${repo}`,
    },
  };
}

function ttlForResult(sourceType: LinkPreviewSourceType, found: boolean): number {
  if (!found) return NEGATIVE_TTL_MS;
  if (sourceType === 'wiki') return WIKI_TTL_MS;
  if (sourceType === 'discord-invite') return DISCORD_INVITE_TTL_MS;
  return PLUGIN_HUB_TTL_MS;
}

function toResult(sourceType: LinkPreviewSourceType, found: boolean, data?: LinkPreviewData): LinkPreviewResult {
  if (!found) return { type: sourceType, found: false };
  // Safe casts: `data` always matches `sourceType`'s own resolver output (see resolveWiki /
  // resolveDiscordInvite / resolvePluginHub above) — this function only reshapes a cache row back
  // into the result union, it never mixes them.
  if (sourceType === 'wiki') {
    return { type: 'wiki', found: true, data: data as import('../models/LinkPreviewCache').WikiPreviewData };
  }
  if (sourceType === 'discord-invite') {
    return {
      type: 'discord-invite',
      found: true,
      data: data as import('../models/LinkPreviewCache').DiscordInvitePreviewData,
    };
  }
  return {
    type: 'plugin-hub',
    found: true,
    data: data as import('../models/LinkPreviewCache').PluginHubPreviewData,
  };
}

/** Resolves a URL to Discord-style preview data, going through the Mongo cache first. Never
 *  throws — any upstream failure (timeout, non-200, malformed body) surfaces as `found: false`
 *  the same as a genuine "page doesn't exist"/"invalid invite"/"unknown plugin", and a URL outside
 *  the wiki/Discord-invite/plugin-hub allowlist surfaces as `{ type: 'unsupported' }` without
 *  touching the network or cache. */
export async function getLinkPreview(rawUrl: string): Promise<LinkPreviewResult> {
  const source = parseLinkPreviewSource(rawUrl);
  if (!source) return { type: 'unsupported' };

  const cached = await LinkPreviewCache.findOne({ sourceType: source.sourceType, key: source.key });
  if (cached && cached.expiresAt > new Date()) {
    return toResult(source.sourceType, cached.found, cached.data);
  }

  let result: LinkPreviewResult;
  if (source.sourceType === 'wiki') result = await resolveWiki(source.key);
  else if (source.sourceType === 'discord-invite') result = await resolveDiscordInvite(source.key);
  else result = await resolvePluginHub(source.key);

  const found = result.type !== 'unsupported' && result.found;
  const data = result.type !== 'unsupported' && result.found ? result.data : undefined;

  await LinkPreviewCache.findOneAndUpdate(
    { sourceType: source.sourceType, key: source.key },
    { found, data, expiresAt: new Date(Date.now() + ttlForResult(source.sourceType, found)) },
    { upsert: true },
  );

  return result;
}
