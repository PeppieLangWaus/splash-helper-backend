/**
 * FC/CC rank -> display name (+ icon where we have one), for the badge shown next to a relayed
 * chat message's sender (see services/chatRelay.ts). Kept in sync with RuneLite's own rank
 * definitions:
 *   - Friends Chat: https://github.com/runelite/runelite/blob/master/runelite-api/src/main/java/net/runelite/api/FriendsChatRank.java
 *   - Clan:         https://github.com/runelite/runelite/blob/master/runelite-api/src/main/java/net/runelite/api/clan/ClanRank.java
 * Icon URLs point at the OSRS Wiki's own rank icon images, so nothing needs to be hosted here.
 */
export interface RankInfo {
  rank: number;
  name: string;
  /** Undefined when this rank has no icon we can resolve server-side (one of a clan's own
   *  custom-titled tiers — see CLAN_RANK_ICONS below). The frontend should fall back to showing
   *  just `name` with no badge in that case. */
  iconUrl?: string;
}

const WIKI_IMAGES = 'https://oldschool.runescape.wiki/images';

// Friends Chat ranks are a fixed, closed set (FriendsChatRank.java) -- every value the game can
// actually send has a name and icon here. The chat-relay plugin sends the rank as this enum's
// *name* (e.g. "OWNER"), not its numeric value, so this is keyed the same way. UNRANKED is
// deliberately left out -- it has no icon in-game, so a lookup miss already means "no badge".
const FRIENDS_CHAT_RANKS: Record<string, RankInfo> = {
  FRIEND: { rank: 0, name: 'Friend', iconUrl: `${WIKI_IMAGES}/Friend_clan_rank.png` },
  RECRUIT: { rank: 1, name: 'Recruit', iconUrl: `${WIKI_IMAGES}/Recruit_clan_rank.png` },
  CORPORAL: { rank: 2, name: 'Corporal', iconUrl: `${WIKI_IMAGES}/Corporal_clan_rank.png` },
  SERGEANT: { rank: 3, name: 'Sergeant', iconUrl: `${WIKI_IMAGES}/Sergeant_clan_rank.png` },
  LIEUTENANT: { rank: 4, name: 'Lieutenant', iconUrl: `${WIKI_IMAGES}/Lieutenant_clan_rank.png` },
  CAPTAIN: { rank: 5, name: 'Captain', iconUrl: `${WIKI_IMAGES}/Captain_clan_rank.png` },
  GENERAL: { rank: 6, name: 'General', iconUrl: `${WIKI_IMAGES}/General_clan_rank.png` },
  OWNER: { rank: 7, name: 'Owner', iconUrl: `${WIKI_IMAGES}/Owner_clan_rank.png` },
  JMOD: { rank: 127, name: 'JMod', iconUrl: `${WIKI_IMAGES}/JMod_clan_rank.png` },
};

/** Resolves a Friends Chat message's `user.friendsChatRank` (the FriendsChatRank enum's *name*,
 *  e.g. "OWNER") to a display name + icon, or null for "UNRANKED"/an unrecognized value. */
export function getFriendsChatRankInfo(rankName: string | undefined): RankInfo | null {
  if (!rankName) return null;
  return FRIENDS_CHAT_RANKS[rankName.toUpperCase()] ?? null;
}

// Clan ranks are almost entirely player-customizable per clan (title + icon set via
// ClanSettings#titleForRank) -- ClanRank.java only defines fixed names for these five numeric
// values, so those are the only ones we can attach a *known* icon to. Everything else (one of the
// ~24 customizable tiers between Guest and Administrator) has no icon we can resolve server-side.
// Unlike Friends Chat ranks, the *display name* for a Clan rank always comes from the payload
// itself (`user.clanRank.title`) rather than this table -- the plugin already resolves the
// clan's own configured title client-side (via ClanSettings#titleForRank), which is the only way
// to get it right for a custom tier. This table exists purely to attach an icon where one exists.
const CLAN_RANK_ICONS: Record<number, string> = {
  [-1]: `${WIKI_IMAGES}/Clan_icon_-_Guest.png`,
  100: `${WIKI_IMAGES}/Clan_icon_-_Administrator.png`,
  125: `${WIKI_IMAGES}/Clan_icon_-_Deputy_owner.png`,
  126: `${WIKI_IMAGES}/Clan_icon_-_Owner.png`,
  127: `${WIKI_IMAGES}/Clan_icon_-_Jmod.png`,
};

/** Icon for a numeric Clan rank, or undefined for one of a clan's own custom-titled tiers. */
export function getClanRankIconUrl(rank: number): string | undefined {
  return CLAN_RANK_ICONS[rank];
}
