import { Router, Request, Response } from 'express';
import { Types } from 'mongoose';
import { requireAuth } from '../middleware/auth';
import { User } from '../models/User';
import { Community } from '../models/Community';
import { ArchivedSession } from '../models/ArchivedSession';
import { Rank } from '../models/Rank';
import { DiscordServerConfig } from '../models/DiscordServerConfig';
import { SplasherApplication } from '../models/SplasherApplication';
import { resolveWebhookField, resolveInviteUrlField } from '../services/discordWebhook';
import { getOrCreateDefaultRank, setMemberRank, assignDefaultRank, getMapEntry } from '../services/ranks';
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
