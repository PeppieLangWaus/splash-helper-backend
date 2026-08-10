import { Router, Request, Response } from 'express';
import { Types } from 'mongoose';
import { requireAuth } from '../middleware/auth';
import { User } from '../models/User';
import { Community } from '../models/Community';
import { ArchivedSession } from '../models/ArchivedSession';
import { BankTicket } from '../models/BankTicket';
import { Rank } from '../models/Rank';
import { DiscordServerConfig } from '../models/DiscordServerConfig';
import { SplasherApplication } from '../models/SplasherApplication';
import { resolveWebhookField, resolveInviteUrlField } from '../services/discordWebhook';
import { resolveIdField, resolveIdListField } from '../services/discordIds';
import { getOrCreateDefaultRank, setMemberRank, assignDefaultRank, getMapEntry } from '../services/ranks';
import {
  resolveChatChannelNameField,
  resolveDisplayNameField,
  applyChatChannelNameUpdate,
  getRecentChatSources,
} from '../services/chatRelay';
import { ChatChannelName } from '../models/ChatChannelName';
import { randomBytes } from 'crypto';

const router = Router();

router.use(requireAuth);

/**
 * POST /api/communities
 * Body: { name: string }
 * Creates a community owned by the requesting user. Requires communityEligible
 * to be set on the user's *current* DB record (not just the JWT claim, since
 * an admin may have revoked eligibility since the token was issued).
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { name } = req.body as { name?: string };
  const trimmedName = name?.trim();
  if (!trimmedName) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const owner = await User.findOne({ username: req.user!.sub });
  if (!owner) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (!owner.communityEligible) {
    res.status(403).json({ error: 'Not eligible to set up a community' });
    return;
  }

  const community = await Community.create({
    name: trimmedName,
    ownerIds: [owner._id],
    memberUserIds: [],
  });
  await getOrCreateDefaultRank(community._id as Types.ObjectId);
  res.status(201).json({ community });
});

/**
 * GET /api/communities/mine
 * Returns communities owned by the requesting user.
 */
router.get('/mine', async (req: Request, res: Response): Promise<void> => {
  const owner = await User.findOne({ username: req.user!.sub }, { _id: 1 }).lean();
  if (!owner) {
    res.json({ communities: [] });
    return;
  }

  const communities = await Community.find({ ownerIds: owner._id }).lean();
  res.json({ communities });
});

/**
 * GET /api/communities
 * Lightweight list of every community (id + name only — no tokens/webhooks), for the
 * "apply to a community" picker.
 */
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const communities = await Community.find({}, { name: 1 }).lean();
  res.json({ communities });
});

/**
 * POST /api/communities/:communityId/apply
 * The requesting user applies to become a splasher for this community. If the community's
 * Discord setup has autoAddSplashers on, they're added immediately; otherwise an application
 * is left pending for staff to approve via a Discord ticket.
 */
router.post('/:communityId/apply', async (req: Request, res: Response): Promise<void> => {
  const { communityId } = req.params;
  const community = await Community.findById(communityId);
  if (!community) {
    res.status(404).json({ error: 'Community not found' });
    return;
  }

  const user = await User.findOne({ username: req.user!.sub });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (community.memberUserIds.some((id) => id.equals(user._id))) {
    res.status(400).json({ error: 'Already a member of this community' });
    return;
  }
  const existingPending = await SplasherApplication.exists({
    communityId: community._id,
    userId: user._id,
    status: 'pending',
  });
  if (existingPending) {
    res.status(400).json({ error: 'Application already pending' });
    return;
  }

  const config = await DiscordServerConfig.findOne({ communityId: community._id });
  if (config?.autoAddSplashers) {
    community.memberUserIds.push(user._id);
    await community.save();
    await assignDefaultRank(user, community._id as Types.ObjectId);
    await user.save();
    await SplasherApplication.create({
      communityId: community._id,
      userId: user._id,
      source: 'website',
      status: 'approved',
      resolvedAt: new Date(),
    });
    res.json({ status: 'added' });
    return;
  }

  await SplasherApplication.create({
    communityId: community._id,
    userId: user._id,
    source: 'website',
    status: 'pending',
  });
  res.json({ status: 'pending' });
});

/**
 * Shared guard: loads the community and confirms the requester is an owner
 * (or an admin). Sends the appropriate error response and returns null if
 * access should be denied.
 */
async function loadOwnedCommunity(req: Request, res: Response) {
  const { communityId } = req.params;
  const community = await Community.findById(communityId);
  if (!community) {
    res.status(404).json({ error: 'Community not found' });
    return null;
  }

  if (req.user!.isAdmin) return community;

  const requester = await User.findOne({ username: req.user!.sub }, { _id: 1 }).lean();
  const isOwner = !!requester && community.ownerIds.some((id) => id.equals(requester._id));
  if (!isOwner) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return community;
}

/**
 * GET /api/communities/:communityId/splashers
 * Returns the splashers (Users) assigned to this community, each with their rank in this
 * community if one is assigned. Owner or admin only.
 */
router.get('/:communityId/splashers', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const [splashers, ranks] = await Promise.all([
    User.find({ _id: { $in: community.memberUserIds } }, { passwordHash: 0 }).lean(),
    Rank.find({ communityId: community._id }).lean(),
  ]);
  const rankById = new Map(ranks.map((r) => [r._id.toString(), r]));
  const communityIdStr = (community._id as Types.ObjectId).toString();

  const withRanks = splashers.map((s) => {
    const rankId = getMapEntry<Types.ObjectId>(s.rankAssignments, communityIdStr);
    const rank = rankId ? rankById.get(rankId.toString()) : undefined;
    return {
      ...s,
      rank: rank ? { id: rank._id, name: rank.name, hourlyRate: rank.hourlyRate } : null,
    };
  });
  res.json({ splashers: withRanks });
});

/**
 * GET /api/communities/:communityId/sessions
 * Returns archived sessions for every splasher assigned to this community, each with the
 * earnings snapshot (rank/rate frozen at finalization time) recorded for this community, if any.
 * Owner or admin only.
 */
router.get('/:communityId/sessions', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const communityIdStr = (community._id as Types.ObjectId).toString();
  const sessions = await ArchivedSession.find({ userId: { $in: community.memberUserIds } }).lean();
  const withEarnings = sessions.map((s) => {
    const earnings = getMapEntry<{ rankId: Types.ObjectId; rankName: string; hourlyRate: number }>(
      s.earningsSnapshot,
      communityIdStr,
    );
    const hours = (s.finalizedTimestamp - s.createdTimestamp) / 3_600_000;
    return {
      ...s,
      earnings: earnings ? { ...earnings, hours, total: hours * earnings.hourlyRate } : null,
    };
  });
  res.json({ sessions: withEarnings });
});

/**
 * GET /api/communities/:communityId/my-payouts
 * The calling user's own payout ticket history in this community — powers the chatbox's Trade
 * tab (splash-helper-frontend's useAccountActivityEvents), which derives earned/paid-out/balance
 * client-side from this plus the splasher's own archived-session earnings (GET /splashers/
 * :username already returns those). Self-scoped by definition — always just the caller's own
 * tickets — so any authenticated user may call it, no owner/admin gate needed unlike the rest of
 * this file.
 */
router.get('/:communityId/my-payouts', async (req: Request, res: Response): Promise<void> => {
  const community = await Community.findById(req.params.communityId);
  if (!community) {
    res.status(404).json({ error: 'Community not found' });
    return;
  }

  const requester = await User.findOne({ username: req.user!.sub }, { _id: 1 }).lean();
  if (!requester) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const tickets = await BankTicket.find(
    { communityId: community._id, requestedByUserId: requester._id, type: 'payout' },
    { amountGp: 1, status: 1, createdAt: 1, resolvedAt: 1 },
  )
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  res.json({
    communityName: community.name,
    payouts: tickets.map((t) => ({
      id: (t._id as Types.ObjectId).toString(),
      amountGp: t.amountGp,
      status: t.status,
      createdAt: t.createdAt.getTime(),
      resolvedAt: t.resolvedAt ? t.resolvedAt.getTime() : null,
    })),
  });
});

/**
 * GET /api/communities/:communityId/ranks
 * List all ranks for this community. Owner or admin only.
 */
router.get('/:communityId/ranks', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const ranks = await Rank.find({ communityId: community._id }).lean();
  res.json({ ranks });
});

/**
 * POST /api/communities/:communityId/ranks
 * Body: { name: string, hourlyRate: number }
 * Creates a new (non-default) rank for this community. Owner or admin only.
 */
router.post('/:communityId/ranks', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const { name, hourlyRate } = req.body as { name?: string; hourlyRate?: number };
  const trimmedName = name?.trim();
  if (!trimmedName) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (typeof hourlyRate !== 'number' || !Number.isFinite(hourlyRate) || hourlyRate < 0) {
    res.status(400).json({ error: 'hourlyRate must be a non-negative number' });
    return;
  }

  const rank = await Rank.create({ communityId: community._id, name: trimmedName, hourlyRate, isDefault: false });
  res.status(201).json({ rank });
});

/**
 * PUT /api/communities/:communityId/ranks/:rankId
 * Body: { name?: string, hourlyRate?: number }
 * Edits an existing rank's name and/or rate. Owner or admin only.
 */
router.put('/:communityId/ranks/:rankId', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const { rankId } = req.params;
  const rank = await Rank.findOne({ _id: rankId, communityId: community._id });
  if (!rank) {
    res.status(404).json({ error: 'Rank not found' });
    return;
  }

  const { name, hourlyRate } = req.body as { name?: unknown; hourlyRate?: unknown };
  if (name !== undefined) {
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }
    rank.name = trimmedName;
  }
  if (hourlyRate !== undefined) {
    if (typeof hourlyRate !== 'number' || !Number.isFinite(hourlyRate) || hourlyRate < 0) {
      res.status(400).json({ error: 'hourlyRate must be a non-negative number' });
      return;
    }
    rank.hourlyRate = hourlyRate;
  }

  await rank.save();
  res.json({ rank });
});

/**
 * DELETE /api/communities/:communityId/ranks/:rankId
 * Deletes a rank, unless it's the default rank, the last remaining rank, or still has
 * members assigned to it (reassign them first). Owner or admin only.
 */
router.delete('/:communityId/ranks/:rankId', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const { rankId } = req.params;
  const rank = await Rank.findOne({ _id: rankId, communityId: community._id });
  if (!rank) {
    res.status(404).json({ error: 'Rank not found' });
    return;
  }
  if (rank.isDefault) {
    res.status(400).json({ error: 'Cannot delete the default rank' });
    return;
  }

  const rankCount = await Rank.countDocuments({ communityId: community._id });
  if (rankCount <= 1) {
    res.status(400).json({ error: 'Cannot delete the last remaining rank' });
    return;
  }

  const communityIdStr = (community._id as Types.ObjectId).toString();
  const memberOnThisRank = await User.exists({
    _id: { $in: community.memberUserIds },
    [`rankAssignments.${communityIdStr}`]: rank._id,
  });
  if (memberOnThisRank) {
    res.status(400).json({ error: 'Reassign members off this rank before deleting it' });
    return;
  }

  await rank.deleteOne();
  res.json({ message: `Rank "${rank.name}" deleted` });
});

/**
 * PUT /api/communities/:communityId/members/:username/rank
 * Body: { rankId: string }
 * Owner or admin only.
 */
router.put('/:communityId/members/:username/rank', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const { username } = req.params;
  const member = await User.findOne({ username });
  if (!member || !community.memberUserIds.some((id) => id.equals(member._id))) {
    res.status(404).json({ error: `"${username}" is not a member of this community` });
    return;
  }

  const { rankId } = req.body as { rankId?: string };
  if (!rankId) {
    res.status(400).json({ error: 'rankId is required' });
    return;
  }
  const rank = await Rank.findOne({ _id: rankId, communityId: community._id });
  if (!rank) {
    res.status(404).json({ error: 'Rank not found in this community' });
    return;
  }

  setMemberRank(member, community._id as Types.ObjectId, rank._id as Types.ObjectId);
  await member.save();
  res.json({ username: member.username, rank: { id: rank._id, name: rank.name, hourlyRate: rank.hourlyRate } });
});

/**
 * PUT /api/communities/:communityId/webhook
 * Body: { activeWebhookUrl?: string | null; historyWebhookUrl?: string | null }
 * Sets or clears this community's Discord webhooks — one for the active-sessions embed,
 * one for archived-session history. Either field may be omitted to leave it unchanged.
 * Owner or admin only.
 */
router.put('/:communityId/webhook', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const { activeWebhookUrl, historyWebhookUrl } = req.body as {
    activeWebhookUrl?: unknown;
    historyWebhookUrl?: unknown;
  };
  const activeUpdate = resolveWebhookField(activeWebhookUrl);
  const historyUpdate = resolveWebhookField(historyWebhookUrl);

  if (activeUpdate.action === 'invalid' || historyUpdate.action === 'invalid') {
    res.status(400).json({ error: 'Not a valid Discord webhook URL' });
    return;
  }

  if (activeUpdate.action === 'set') community.discordActiveWebhookUrl = activeUpdate.value;
  else if (activeUpdate.action === 'clear') community.discordActiveWebhookUrl = undefined;

  if (historyUpdate.action === 'set') community.discordHistoryWebhookUrl = historyUpdate.value;
  else if (historyUpdate.action === 'clear') community.discordHistoryWebhookUrl = undefined;

  await community.save();
  res.json({ community });
});

/**
 * PUT /api/communities/:communityId/discord-invite
 * Body: { discordInviteUrl?: string | null }
 * Sets or clears this community's public Discord invite link. Owner or admin only.
 */
router.put('/:communityId/discord-invite', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const { discordInviteUrl } = req.body as { discordInviteUrl?: unknown };
  const update = resolveInviteUrlField(discordInviteUrl);
  if (update.action === 'invalid') {
    res.status(400).json({ error: 'Not a valid Discord invite URL' });
    return;
  }

  if (update.action === 'set') community.discordInviteUrl = update.value;
  else if (update.action === 'clear') community.discordInviteUrl = undefined;

  await community.save();
  res.json({ community });
});

/**
 * GET /api/communities/:communityId/chat-config
 * Returns this community's registered Friends/Clan Chat names and chat Discord webhook — the
 * settings that drive the global chat.splasher.help / chat.ardy.host relay (services/chatRelay.ts).
 * Owner or admin only.
 */
router.get('/:communityId/chat-config', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const names = await ChatChannelName.find({ communityId: community._id }).lean();
  res.json({
    friendsChatName: names.find((n) => n.channelType === 'fc')?.name ?? null,
    friendsChatDisplayName: names.find((n) => n.channelType === 'fc')?.displayName ?? null,
    clanChatName: names.find((n) => n.channelType === 'cc')?.name ?? null,
    discordFriendsChatWebhookUrl: community.discordFriendsChatWebhookUrl ?? null,
    discordClanChatWebhookUrl: community.discordClanChatWebhookUrl ?? null,
  });
});

/**
 * PUT /api/communities/:communityId/chat-config
 * Body: { friendsChatName?, friendsChatDisplayName?, clanChatName?, discordFriendsChatWebhookUrl?,
 *          discordClanChatWebhookUrl?: string | null }
 * Registers this community's Friends/Clan Chat names (each must be globally unique — see
 * ChatChannelName), the Friends Chat's cosmetic display name, and/or its two chat-relay Discord
 * webhooks. Any field may be omitted to leave it unchanged; an empty string clears it. Owner or
 * admin only.
 */
router.put('/:communityId/chat-config', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const {
    friendsChatName,
    friendsChatDisplayName,
    clanChatName,
    discordFriendsChatWebhookUrl,
    discordClanChatWebhookUrl,
  } = req.body as {
    friendsChatName?: unknown;
    friendsChatDisplayName?: unknown;
    clanChatName?: unknown;
    discordFriendsChatWebhookUrl?: unknown;
    discordClanChatWebhookUrl?: unknown;
  };

  const communityId = community._id as Types.ObjectId;
  const [friendsUpdate, clanUpdate] = await Promise.all([
    resolveChatChannelNameField(friendsChatName, communityId, 'fc'),
    resolveChatChannelNameField(clanChatName, communityId, 'cc'),
  ]);
  const displayNameUpdate = resolveDisplayNameField(friendsChatDisplayName);
  const friendsWebhookUpdate = resolveWebhookField(discordFriendsChatWebhookUrl);
  const clanWebhookUpdate = resolveWebhookField(discordClanChatWebhookUrl);

  if (friendsUpdate.action === 'invalid' || clanUpdate.action === 'invalid') {
    res.status(400).json({ error: 'Chat names must be non-empty strings under 100 characters' });
    return;
  }
  if (displayNameUpdate.action === 'invalid') {
    res.status(400).json({ error: 'Display name must be a non-empty string under 100 characters' });
    return;
  }
  if (friendsUpdate.action === 'taken') {
    res.status(409).json({ error: 'That Friends Chat name is already registered to another community' });
    return;
  }
  if (clanUpdate.action === 'taken') {
    res.status(409).json({ error: 'That Clan Chat name is already registered to another community' });
    return;
  }
  if (friendsWebhookUpdate.action === 'invalid' || clanWebhookUpdate.action === 'invalid') {
    res.status(400).json({ error: 'Not a valid Discord webhook URL' });
    return;
  }

  await Promise.all([
    applyChatChannelNameUpdate(communityId, 'fc', friendsUpdate, displayNameUpdate),
    applyChatChannelNameUpdate(communityId, 'cc', clanUpdate),
  ]);

  if (friendsWebhookUpdate.action === 'set') community.discordFriendsChatWebhookUrl = friendsWebhookUpdate.value;
  else if (friendsWebhookUpdate.action === 'clear') community.discordFriendsChatWebhookUrl = undefined;
  if (clanWebhookUpdate.action === 'set') community.discordClanChatWebhookUrl = clanWebhookUpdate.value;
  else if (clanWebhookUpdate.action === 'clear') community.discordClanChatWebhookUrl = undefined;
  await community.save();

  const names = await ChatChannelName.find({ communityId }).lean();
  res.json({
    friendsChatName: names.find((n) => n.channelType === 'fc')?.name ?? null,
    friendsChatDisplayName: names.find((n) => n.channelType === 'fc')?.displayName ?? null,
    clanChatName: names.find((n) => n.channelType === 'cc')?.name ?? null,
    discordFriendsChatWebhookUrl: community.discordFriendsChatWebhookUrl ?? null,
    discordClanChatWebhookUrl: community.discordClanChatWebhookUrl ?? null,
  });
});

/**
 * GET /api/communities/:communityId/chat-sources
 * Recent sources (IP + claimed player name) seen posting to this community's chat relay, plus
 * the current block-list, so the owner can see who to block. Owner or admin only.
 */
router.get('/:communityId/chat-sources', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  res.json({
    recent: getRecentChatSources((community._id as Types.ObjectId).toString()),
    blocked: community.blockedChatSources,
  });
});

/**
 * POST /api/communities/:communityId/chat-sources/block
 * Body: { ip?: string; playerName?: string } — at least one required.
 * Blocks a source from this community's chat relay going forward. Owner or admin only.
 */
router.post('/:communityId/chat-sources/block', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const { ip, playerName } = req.body as { ip?: unknown; playerName?: unknown };
  const trimmedIp = typeof ip === 'string' ? ip.trim() : '';
  const trimmedName = typeof playerName === 'string' ? playerName.trim() : '';
  if (!trimmedIp && !trimmedName) {
    res.status(400).json({ error: 'ip or playerName is required' });
    return;
  }

  community.blockedChatSources.push({
    ip: trimmedIp || undefined,
    playerName: trimmedName || undefined,
    blockedAt: new Date(),
  });
  await community.save();
  res.status(201).json({ blockedChatSources: community.blockedChatSources });
});

/**
 * DELETE /api/communities/:communityId/chat-sources/block
 * Body: { ip?: string; playerName?: string }
 * Removes matching entries from the block-list. Owner or admin only.
 */
router.delete('/:communityId/chat-sources/block', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const { ip, playerName } = req.body as { ip?: unknown; playerName?: unknown };
  const trimmedIp = typeof ip === 'string' ? ip.trim() : undefined;
  const trimmedName = typeof playerName === 'string' ? playerName.trim().toLowerCase() : undefined;

  community.blockedChatSources = community.blockedChatSources.filter((blocked) => {
    const matchesIp = !!trimmedIp && blocked.ip === trimmedIp;
    const matchesName = !!trimmedName && blocked.playerName?.toLowerCase() === trimmedName;
    return !(matchesIp || matchesName);
  });
  await community.save();
  res.json({ blockedChatSources: community.blockedChatSources });
});

/**
 * GET /api/communities/:communityId/discord-config
 * Returns this community's /setup configuration (channel/role ids, auto-add, bank settings)
 * — the same document the Discord bot's /setup wizard writes via the community-token-authenticated
 * /api/community-bot/discord-config route. null until the owner has run /setup at least once.
 * Owner or admin only.
 */
router.get('/:communityId/discord-config', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const config = await DiscordServerConfig.findOne({ communityId: community._id }).lean();
  res.json({ config });
});

/**
 * PUT /api/communities/:communityId/discord-config
 * Body: { supportRoleIds?, supportTicketChannelId?, splasherLinkChannelId?, historyChannelId?,
 *         activeWorldsChannelId?, autoAddSplashers?, bankChannelId?, bankManagerRoleIds?,
 *         minPayoutGp? }
 * Edits the same config the /setup wizard collects — every field is optional and omitting one
 * leaves it unchanged; an empty string/array clears it. Requires the community to have already
 * run /setup at least once, since guildId is only ever established by that bootstrap handshake
 * and this route never touches it. Owner or admin only.
 */
router.put('/:communityId/discord-config', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const config = await DiscordServerConfig.findOne({ communityId: community._id });
  if (!config) {
    res.status(404).json({
      error: 'Run /setup in Discord first to link this server before editing its config here.',
    });
    return;
  }

  const body = req.body as Partial<{
    supportRoleIds: unknown;
    supportTicketChannelId: unknown;
    splasherLinkChannelId: unknown;
    historyChannelId: unknown;
    activeWorldsChannelId: unknown;
    autoAddSplashers: unknown;
    bankChannelId: unknown;
    bankManagerRoleIds: unknown;
    minPayoutGp: unknown;
  }>;

  const supportTicketChannelIdUpdate = resolveIdField(body.supportTicketChannelId);
  const splasherLinkChannelIdUpdate = resolveIdField(body.splasherLinkChannelId);
  const historyChannelIdUpdate = resolveIdField(body.historyChannelId);
  const activeWorldsChannelIdUpdate = resolveIdField(body.activeWorldsChannelId);
  const bankChannelIdUpdate = resolveIdField(body.bankChannelId);
  const supportRoleIdsUpdate = resolveIdListField(body.supportRoleIds);
  const bankManagerRoleIdsUpdate = resolveIdListField(body.bankManagerRoleIds);

  const anyInvalid = [
    supportTicketChannelIdUpdate,
    splasherLinkChannelIdUpdate,
    historyChannelIdUpdate,
    activeWorldsChannelIdUpdate,
    bankChannelIdUpdate,
    supportRoleIdsUpdate,
    bankManagerRoleIdsUpdate,
  ].some((u) => u.action === 'invalid');
  if (anyInvalid) {
    res.status(400).json({ error: 'Channel and role ids must be valid Discord snowflakes (17-20 digits)' });
    return;
  }

  if (body.autoAddSplashers !== undefined && typeof body.autoAddSplashers !== 'boolean') {
    res.status(400).json({ error: 'autoAddSplashers must be a boolean' });
    return;
  }

  if (body.minPayoutGp !== undefined) {
    const { minPayoutGp } = body;
    if (typeof minPayoutGp !== 'number' || !Number.isFinite(minPayoutGp) || minPayoutGp < 0) {
      res.status(400).json({ error: 'minPayoutGp must be a non-negative number' });
      return;
    }
    config.minPayoutGp = minPayoutGp;
  }

  if (supportTicketChannelIdUpdate.action === 'set') config.supportTicketChannelId = supportTicketChannelIdUpdate.value;
  else if (supportTicketChannelIdUpdate.action === 'clear') config.supportTicketChannelId = undefined;

  if (splasherLinkChannelIdUpdate.action === 'set') config.splasherLinkChannelId = splasherLinkChannelIdUpdate.value;
  else if (splasherLinkChannelIdUpdate.action === 'clear') config.splasherLinkChannelId = undefined;

  if (historyChannelIdUpdate.action === 'set') config.historyChannelId = historyChannelIdUpdate.value;
  else if (historyChannelIdUpdate.action === 'clear') config.historyChannelId = undefined;

  if (activeWorldsChannelIdUpdate.action === 'set') config.activeWorldsChannelId = activeWorldsChannelIdUpdate.value;
  else if (activeWorldsChannelIdUpdate.action === 'clear') config.activeWorldsChannelId = undefined;

  if (bankChannelIdUpdate.action === 'set') config.bankChannelId = bankChannelIdUpdate.value;
  else if (bankChannelIdUpdate.action === 'clear') config.bankChannelId = undefined;

  if (supportRoleIdsUpdate.action === 'set') config.supportRoleIds = supportRoleIdsUpdate.value;
  if (bankManagerRoleIdsUpdate.action === 'set') config.bankManagerRoleIds = bankManagerRoleIdsUpdate.value;

  if (body.autoAddSplashers !== undefined) config.autoAddSplashers = body.autoAddSplashers as boolean;

  await config.save();
  res.json({ config });
});

/**
 * POST /api/communities/:communityId/api-token/regenerate
 * Rotates this community's API token (used by the Discord bot and any other external
 * community-scoped access). Returns the new raw value — it isn't a show-once secret, it's
 * also shown back to the owner in Account Settings. Owner or admin only.
 */
router.post('/:communityId/api-token/regenerate', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  community.apiToken = randomBytes(32).toString('hex');
  await community.save();
  res.json({ apiToken: community.apiToken });
});

/**
 * PUT /api/communities/:communityId/members/:username/webhook
 * Body: { activeWebhookUrl?: string | null; historyWebhookUrl?: string | null }
 * Lets the community owner (or admin) set a personal Discord webhook override for one of
 * their members, on the member's own User record — the same fields the splasher could set
 * themselves via PUT /api/splashers/:username/webhook. Additive with the community's webhook.
 */
router.put('/:communityId/members/:username/webhook', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const { username } = req.params;
  const member = await User.findOne({ username });
  if (!member || !community.memberUserIds.some((id) => id.equals(member._id))) {
    res.status(404).json({ error: `"${username}" is not a member of this community` });
    return;
  }

  const { activeWebhookUrl, historyWebhookUrl } = req.body as {
    activeWebhookUrl?: unknown;
    historyWebhookUrl?: unknown;
  };
  const activeUpdate = resolveWebhookField(activeWebhookUrl);
  const historyUpdate = resolveWebhookField(historyWebhookUrl);

  if (activeUpdate.action === 'invalid' || historyUpdate.action === 'invalid') {
    res.status(400).json({ error: 'Not a valid Discord webhook URL' });
    return;
  }

  if (activeUpdate.action === 'set') member.discordActiveWebhookUrl = activeUpdate.value;
  else if (activeUpdate.action === 'clear') member.discordActiveWebhookUrl = undefined;

  if (historyUpdate.action === 'set') member.discordHistoryWebhookUrl = historyUpdate.value;
  else if (historyUpdate.action === 'clear') member.discordHistoryWebhookUrl = undefined;

  await member.save();
  res.json({
    username: member.username,
    discordActiveWebhookUrl: member.discordActiveWebhookUrl,
    discordHistoryWebhookUrl: member.discordHistoryWebhookUrl,
  });
});

export default router;
