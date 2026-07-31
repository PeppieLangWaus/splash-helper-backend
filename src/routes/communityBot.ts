import { Router, Request, Response } from 'express';
import { Types } from 'mongoose';
import { Community } from '../models/Community';
import { User } from '../models/User';
import { DiscordServerConfig } from '../models/DiscordServerConfig';
import { SplasherApplication } from '../models/SplasherApplication';
import { SecurityEvent } from '../models/SecurityEvent';
import { requireCommunityToken } from '../middleware/auth';
import { assignDefaultRank } from '../services/ranks';

const router = Router();

/**
 * POST /api/community-bot/verify-setup
 * Body: { communityName, apiToken, guildId, discordUserId }
 * Bootstrap handshake for the bot's /setup command — deliberately *not* behind
 * requireCommunityToken, since the bot doesn't have a trusted per-guild token yet at this
 * point. Confirms the supplied token actually belongs to the community with the given name;
 * any mismatch is logged for human review rather than silently rejected, since this is the
 * one place someone could try pairing a Discord server with a community's data using a
 * guessed/stolen token.
 */
router.post('/verify-setup', async (req: Request, res: Response): Promise<void> => {
  const { communityName, apiToken, guildId, discordUserId } = req.body as {
    communityName?: string;
    apiToken?: string;
    guildId?: string;
    discordUserId?: string;
  };

  if (!communityName?.trim() || !apiToken?.trim() || !guildId || !discordUserId) {
    res.status(400).json({ error: 'communityName, apiToken, guildId, and discordUserId are required' });
    return;
  }
  const trimmedName = communityName.trim();

  const community = await Community.findOne({ name: trimmedName }).collation({ locale: 'en', strength: 2 });
  if (!community) {
    await SecurityEvent.create({
      type: 'setup-unknown-community',
      guildId,
      discordUserId,
      attemptedName: trimmedName,
    });
    res.status(404).json({ error: 'No community found with that name. This attempt has been logged.' });
    return;
  }

  if (community.apiToken !== apiToken.trim()) {
    await SecurityEvent.create({
      type: 'setup-token-mismatch',
      communityId: community._id,
      guildId,
      discordUserId,
      attemptedName: trimmedName,
    });
    res.status(403).json({ error: 'Community name and API token do not match. This attempt has been logged.' });
    return;
  }

  res.json({ communityId: community._id, communityName: community.name });
});

// Everything below is an ongoing, per-guild bot call — authenticated by the community's
// apiToken alone. Every handler operates strictly on req.community, never a client-supplied
// community id, so one community's token can never read or mutate another's data.
router.use(requireCommunityToken);

/**
 * GET /api/community-bot/discord-config
 */
router.get('/discord-config', async (req: Request, res: Response): Promise<void> => {
  const config = await DiscordServerConfig.findOne({ communityId: req.community!._id }).lean();
  res.json({ config });
});

/**
 * PUT /api/community-bot/discord-config
 * Body: { guildId, supportRoleIds?, supportTicketChannelId?, splasherLinkChannelId?,
 *         historyChannelId?, activeWorldsChannelId?, autoAddSplashers? }
 * Used once, right after /setup verifies the community token.
 */
router.put('/discord-config', async (req: Request, res: Response): Promise<void> => {
  const communityId = req.community!._id as Types.ObjectId;
  const {
    guildId,
    supportRoleIds,
    supportTicketChannelId,
    splasherLinkChannelId,
    historyChannelId,
    activeWorldsChannelId,
    autoAddSplashers,
  } = req.body as Partial<{
    guildId: string;
    supportRoleIds: string[];
    supportTicketChannelId: string;
    splasherLinkChannelId: string;
    historyChannelId: string;
    activeWorldsChannelId: string;
    autoAddSplashers: boolean;
  }>;

  if (!guildId) {
    res.status(400).json({ error: 'guildId is required' });
    return;
  }

  const config = await DiscordServerConfig.findOneAndUpdate(
    { communityId },
    {
      communityId,
      guildId,
      supportRoleIds: Array.isArray(supportRoleIds) ? supportRoleIds : [],
      supportTicketChannelId,
      splasherLinkChannelId,
      historyChannelId,
      activeWorldsChannelId,
      autoAddSplashers: !!autoAddSplashers,
    },
    { upsert: true, new: true },
  );
  res.json({ config });
});

/**
 * GET /api/community-bot/applications?status=pending
 * The bot polls this for applications that came in through the website rather than /link.
 */
router.get('/applications', async (req: Request, res: Response): Promise<void> => {
  const { status } = req.query as { status?: string };
  const filter: Record<string, unknown> = { communityId: req.community!._id };
  if (status) filter.status = status;
  const applications = await SplasherApplication.find(filter).lean();
  res.json({ applications });
});

/**
 * POST /api/community-bot/applications/:appId/resolve
 * Body: { approve: boolean }
 * Called when staff click Approve/Reject on a ticket thread.
 */
router.post('/applications/:appId/resolve', async (req: Request, res: Response): Promise<void> => {
  const { appId } = req.params;
  const { approve } = req.body as { approve?: boolean };

  // Scoped to req.community._id: an application id from a different community 404s here
  // rather than being resolvable by a token that doesn't own it.
  const application = await SplasherApplication.findOne({ _id: appId, communityId: req.community!._id });
  if (!application) {
    res.status(404).json({ error: 'Application not found' });
    return;
  }
  if (application.status !== 'pending') {
    res.status(400).json({ error: `Application already ${application.status}` });
    return;
  }

  if (approve) {
    const user = await User.findById(application.userId);
    if (user) {
      await Community.updateOne({ _id: req.community!._id }, { $addToSet: { memberUserIds: user._id } });
      await assignDefaultRank(user, req.community!._id as Types.ObjectId);
      await user.save();
    }
    application.status = 'approved';
  } else {
    application.status = 'rejected';
  }
  application.resolvedAt = new Date();
  await application.save();

  res.json({ application });
});

/**
 * POST /api/community-bot/link-account
 * Body: { token, rsn }
 * Verifies a plugin token + RSN match a real account, then applies the same auto-add-or-
 * pending logic as the website's POST /communities/:id/apply, scoped to this token's community.
 */
router.post('/link-account', async (req: Request, res: Response): Promise<void> => {
  const { token, rsn } = req.body as { token?: string; rsn?: string };
  if (!token || !rsn) {
    res.status(400).json({ error: 'token and rsn are required' });
    return;
  }

  const user = await User.findOne({ username: rsn, token });
  if (!user) {
    res.json({ matched: false, status: 'no-match' });
    return;
  }

  const community = req.community!;
  const communityId = community._id as Types.ObjectId;
  const alreadyMember = community.memberUserIds.some((id) => id.equals(user._id));
  if (alreadyMember) {
    res.json({ matched: true, status: 'added', communityName: community.name });
    return;
  }

  const config = await DiscordServerConfig.findOne({ communityId });
  if (config?.autoAddSplashers) {
    await Community.updateOne({ _id: communityId }, { $addToSet: { memberUserIds: user._id } });
    await assignDefaultRank(user, communityId);
    await user.save();
    const application = await SplasherApplication.create({
      communityId,
      userId: user._id,
      source: 'discord-link',
      status: 'approved',
      resolvedAt: new Date(),
    });
    res.json({ matched: true, status: 'added', communityName: community.name, applicationId: application._id });
    return;
  }

  const application = await SplasherApplication.create({
    communityId,
    userId: user._id,
    source: 'discord-link',
    status: 'pending',
  });
  // The bot needs applicationId to attach Approve/Reject buttons to this specific ticket.
  res.json({ matched: true, status: 'pending', communityName: community.name, applicationId: application._id });
});

export default router;
