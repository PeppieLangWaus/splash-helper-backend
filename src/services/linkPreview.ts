import { logWarn } from '../utils/logger';
import { LinkPreviewCache, LinkPreviewData, LinkPreviewSourceType } from '../models/LinkPreviewCache';

// Discord-style hover previews for the two link types actually pasted into "regular" (non-chat)
// pages on the site — OSRS Wiki articles (guide pages) and a community's public Discord invite
// (routes/communities.ts's `discordInviteUrl`, shown e.g. in SessionPanel). Deliberately not
// general-purpose OpenGraph scraping of arbitrary URLs — see the domain allowlist in
// `parseLinkPreviewSource` below. Every result (including "not found") is cached in Mongo
// (models/LinkPreviewCache.ts) so a link hovered by many visitors only ever hits the upstream API
// once per TTL window, rather than once per browser.

const USER_AGENT = 'splash-helper-backend (+https://github.com/PeppieLangWaus/splash-helper-backend)';
const FETCH_TIMEOUT_MS = 4_000;

// Wiki articles change rarely — cache generously. Discord invite metadata (member/online counts,
// and the guild could rename itself) is more of a live-ish snapshot, so it gets a much shorter
// TTL. Either way a "not found" result gets the shortest TTL of all, so a broken/typo'd link
// self-heals quickly instead of staying cached-broken for days.
const WIKI_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DISCORD_INVITE_TTL_MS = 45 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 60 * 1000;

const WIKI_HOSTNAMES = new Set(['oldschool.runescape.wiki']);
// Mirrors services/discordWebhook.ts's DISCORD_INVITE_URL_PATTERN (kept separate rather than
// imported since that one only validates, it doesn't capture the code) — matches
// discord.gg/<code> and discord(app).com/invite/<code>, including a vanity code like
// discord.gg/some-community-name.
const DISCORD_INVITE_URL_PATTERN =
  /^https:\/\/(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)([\w-]+)\/?$/;

export type LinkPreviewResult =
  | { type: 'wiki'; found: true; data: import('../models/LinkPreviewCache').WikiPreviewData }
  | { type: 'discord-invite'; found: true; data: import('../models/LinkPreviewCache').DiscordInvitePreviewData }
  | { type: 'wiki' | 'discord-invite'; found: false }
  | { type: 'unsupported' };

type LinkSource =
  | { sourceType: 'wiki'; key: string }
  | { sourceType: 'discord-invite'; key: string };

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

  return null;
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    return { status: res.status, body: await res.json().catch(() => null) };
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

function ttlForResult(sourceType: LinkPreviewSourceType, found: boolean): number {
  if (!found) return NEGATIVE_TTL_MS;
  return sourceType === 'wiki' ? WIKI_TTL_MS : DISCORD_INVITE_TTL_MS;
}

function toResult(sourceType: LinkPreviewSourceType, found: boolean, data?: LinkPreviewData): LinkPreviewResult {
  if (!found) return { type: sourceType, found: false };
  // Safe casts: `data` always matches `sourceType`'s own resolver output (see resolveWiki /
  // resolveDiscordInvite above) — this function only reshapes a cache row back into the result
  // union, it never mixes the two.
  if (sourceType === 'wiki') {
    return { type: 'wiki', found: true, data: data as import('../models/LinkPreviewCache').WikiPreviewData };
  }
  return {
    type: 'discord-invite',
    found: true,
    data: data as import('../models/LinkPreviewCache').DiscordInvitePreviewData,
  };
}

/** Resolves a URL to Discord-style preview data, going through the Mongo cache first. Never
 *  throws — any upstream failure (timeout, non-200, malformed body) surfaces as `found: false`
 *  the same as a genuine "page doesn't exist"/"invalid invite", and a URL outside the wiki/Discord
 *  invite allowlist surfaces as `{ type: 'unsupported' }` without touching the network or cache. */
export async function getLinkPreview(rawUrl: string): Promise<LinkPreviewResult> {
  const source = parseLinkPreviewSource(rawUrl);
  if (!source) return { type: 'unsupported' };

  const cached = await LinkPreviewCache.findOne({ sourceType: source.sourceType, key: source.key });
  if (cached && cached.expiresAt > new Date()) {
    return toResult(source.sourceType, cached.found, cached.data);
  }

  const result =
    source.sourceType === 'wiki' ? await resolveWiki(source.key) : await resolveDiscordInvite(source.key);
  const found = result.type !== 'unsupported' && result.found;
  const data = result.type !== 'unsupported' && result.found ? result.data : undefined;

  await LinkPreviewCache.findOneAndUpdate(
    { sourceType: source.sourceType, key: source.key },
    { found, data, expiresAt: new Date(Date.now() + ttlForResult(source.sourceType, found)) },
    { upsert: true },
  );

  return result;
}
