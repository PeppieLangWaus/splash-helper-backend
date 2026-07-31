import { Router, Request, Response } from 'express';
import { Types } from 'mongoose';
import { Community } from '../models/Community';
import { User } from '../models/User';
import { DiscordServerConfig } from '../models/DiscordServerConfig';
import { SplasherApplication } from '../models/SplasherApplication';
import { SecurityEvent } from '../models/SecurityEvent';
import { ArchivedSession } from '../models/ArchivedSession';
import { BankTicket, BankTicketType } from '../models/BankTicket';
import { requireCommunityToken } from '../middleware/auth';
import { assignDefaultRank } from '../services/ranks';
import { computeTotalEarnedGp, computeTotalPaidOutGp } from '../services/income';
import { getAll as getActiveSessions } from '../websocket/sessionManager';

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
    bankChannelId,
    bankManagerRoleIds,
    minPayoutGp,
  } = req.body as Partial<{
    guildId: string;
    supportRoleIds: string[];
    supportTicketChannelId: string;
    splasherLinkChannelId: string;
    historyChannelId: string;
    activeWorldsChannelId: string;
    autoAddSplashers: boolean;
    bankChannelId: string;
    bankManagerRoleIds: string[];
    minPayoutGp: number;
  }>;

  if (!guildId) {
    res.status(400).json({ error: 'guildId is required' });
    return;
  }

  const validMinPayout =
    typeof minPayoutGp === 'number' && Number.isFinite(minPayoutGp) && minPayoutGp >= 0;

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
      bankChannelId,
      bankManagerRoleIds: Array.isArray(bankManagerRoleIds) ? bankManagerRoleIds : [],
      minPayoutGp: validMinPayout ? minPayoutGp : 10_000_000,
    },
    { upsert: true, new: true },
  );
  res.json({ config });
});

/**
 * GET /api/community-bot/active-sessions
 * In-progress splash sessions belonging to this community's members right now. Powers the
 * bot's active-worlds channel message.
 */
router.get('/active-sessions', async (req: Request, res: Response): Promise<void> => {
  const memberIds = new Set(req.community!.memberUserIds.map((id) => id.toString()));

  const sessions = getActiveSessions()
    .filter((s) => s.authenticated && s.sessionData !== null && memberIds.has(s.userId))
    .map((s) => ({ username: s.username, session: s.sessionData }));

  res.json({ sessions });
});

/**
 * GET /api/community-bot/sessions/history?since=<epoch-ms>
 * Archived sessions belonging to this community's members finalized after `since` (defaults
 * to 0, i.e. everything), oldest first. Powers the bot's history channel messages — the bot
 * tracks its own `since` cursor per guild and posts one message per entry returned here.
 */
router.get('/sessions/history', async (req: Request, res: Response): Promise<void> => {
  const since = Number(req.query.since) || 0;

  const sessions = await ArchivedSession.find({
    userId: { $in: req.community!.memberUserIds },
    finalizedTimestamp: { $gt: since },
  })
    .sort({ finalizedTimestamp: 1 })
    .lean();

  res.json({
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      username: s.username,
      createdTimestamp: s.createdTimestamp,
      finalizedTimestamp: s.finalizedTimestamp,
      session: s.session,
    })),
  });
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
  const { token, rsn, discordUserId } = req.body as { token?: string; rsn?: string; discordUserId?: string };
  if (!token || !rsn) {
    res.status(400).json({ error: 'token and rsn are required' });
    return;
  }

  const user = await User.findOne({ username: rsn, token });
  if (!user) {
    res.json({ matched: false, status: 'no-match' });
    return;
  }

  if (discordUserId && user.discordUserId !== discordUserId) {
    user.discordUserId = discordUserId;
    await user.save();
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

/** Resolves a Discord user to their backend User, scoped to this community's membership — see
 *  User.discordUserId's doc comment for why membership scoping matters, not just the id match. */
async function findLinkedMember(communityId: Types.ObjectId, memberUserIds: Types.ObjectId[], discordUserId: string) {
  return User.findOne({ discordUserId, _id: { $in: memberUserIds } });
}

/**
 * GET /api/community-bot/income?discordUserId=
 * How much a linked splasher has earned in this community, how much of that has already been
 * paid out, and what's still available to pay out.
 */
router.get('/income', async (req: Request, res: Response): Promise<void> => {
  const { discordUserId } = req.query as { discordUserId?: string };
  if (!discordUserId) {
    res.status(400).json({ error: 'discordUserId is required' });
    return;
  }

  const community = req.community!;
  const communityId = community._id as Types.ObjectId;
  const user = await findLinkedMember(communityId, community.memberUserIds, discordUserId);
  if (!user) {
    res.json({ linked: false });
    return;
  }

  const [totalEarnedGp, totalPaidOutGp] = await Promise.all([
    computeTotalEarnedGp(user._id as Types.ObjectId, communityId),
    computeTotalPaidOutGp(user._id as Types.ObjectId, communityId),
  ]);
  const config = await DiscordServerConfig.findOne({ communityId }).lean();

  res.json({
    linked: true,
    username: user.username,
    totalEarnedGp: Math.round(totalEarnedGp),
    totalPaidOutGp: Math.round(totalPaidOutGp),
    availableGp: Math.round(totalEarnedGp - totalPaidOutGp),
    minPayoutGp: config?.minPayoutGp ?? 10_000_000,
  });
});

/**
 * POST /api/community-bot/income/payout
 * Body: { discordUserId }
 * Opens a pending payout BankTicket for the splasher's full available balance, if they meet the
 * community's minimum payout threshold. Staff still have to Accept it (with a screenshot) via
 * POST /bank/tickets/:id/resolve before anything actually moves.
 */
router.post('/income/payout', async (req: Request, res: Response): Promise<void> => {
  const { discordUserId } = req.body as { discordUserId?: string };
  if (!discordUserId) {
    res.status(400).json({ error: 'discordUserId is required' });
    return;
  }

  const community = req.community!;
  const communityId = community._id as Types.ObjectId;
  const user = await findLinkedMember(communityId, community.memberUserIds, discordUserId);
  if (!user) {
    res.status(404).json({ error: 'No linked account found for this community — run /link first.' });
    return;
  }

  const [totalEarnedGp, totalPaidOutGp, config] = await Promise.all([
    computeTotalEarnedGp(user._id as Types.ObjectId, communityId),
    computeTotalPaidOutGp(user._id as Types.ObjectId, communityId),
    DiscordServerConfig.findOne({ communityId }).lean(),
  ]);
  const availableGp = Math.round(totalEarnedGp - totalPaidOutGp);
  const minPayoutGp = config?.minPayoutGp ?? 10_000_000;

  if (availableGp < minPayoutGp) {
    res.status(400).json({ error: 'Not enough available gp for a payout yet.', availableGp, minPayoutGp });
    return;
  }

  const ticket = await BankTicket.create({
    communityId,
    type: 'payout',
    amountGp: availableGp,
    requestedByUserId: user._id,
    requestedByUsername: user.username,
    requestedByDiscordId: discordUserId,
  });
  res.status(201).json({ ticket });
});

/**
 * GET /api/community-bot/bank
 * The community's current GP balance plus its configured payout threshold.
 */
router.get('/bank', async (req: Request, res: Response): Promise<void> => {
  const community = req.community!;
  const config = await DiscordServerConfig.findOne({ communityId: community._id }).lean();
  res.json({ bankGp: community.bankGp, minPayoutGp: config?.minPayoutGp ?? 10_000_000 });
});

/**
 * POST /api/community-bot/bank/tickets
 * Body: { type: 'deposit' | 'withdraw', amountGp, discordUserId, discordUsername }
 * Opens a pending deposit/withdraw ticket. Role-gating (only bank managers may call this) is the
 * bot's responsibility, same as every other staff-only action here — this route only trusts the
 * community token, not any notion of "who's allowed".
 */
router.post('/bank/tickets', async (req: Request, res: Response): Promise<void> => {
  const { type, amountGp, discordUserId, discordUsername } = req.body as {
    type?: BankTicketType;
    amountGp?: number;
    discordUserId?: string;
    discordUsername?: string;
  };

  if (type !== 'deposit' && type !== 'withdraw') {
    res.status(400).json({ error: "type must be 'deposit' or 'withdraw'" });
    return;
  }
  if (typeof amountGp !== 'number' || !Number.isFinite(amountGp) || amountGp <= 0) {
    res.status(400).json({ error: 'amountGp must be a positive number' });
    return;
  }
  if (!discordUserId || !discordUsername) {
    res.status(400).json({ error: 'discordUserId and discordUsername are required' });
    return;
  }

  const community = req.community!;
  if (type === 'withdraw' && amountGp > community.bankGp) {
    res.status(400).json({ error: 'Insufficient bank balance for this withdrawal.', bankGp: community.bankGp });
    return;
  }

  const linkedUser = await findLinkedMember(community._id as Types.ObjectId, community.memberUserIds, discordUserId);
  const ticket = await BankTicket.create({
    communityId: community._id,
    type,
    amountGp,
    requestedByUserId: linkedUser?._id,
    requestedByUsername: discordUsername,
    requestedByDiscordId: discordUserId,
  });
  res.status(201).json({ ticket });
});

/**
 * POST /api/community-bot/bank/tickets/:ticketId/resolve
 * Body: { approve, screenshotUrl?, authorizedByDiscordId, authorizedByUsername }
 * Rejecting just closes the ticket out. Approving requires a screenshot and actually moves the
 * bank balance — deposits add, withdrawals/payouts subtract (re-checked against the *current*
 * balance here, since it may have moved since the ticket was opened).
 */
router.post('/bank/tickets/:ticketId/resolve', async (req: Request, res: Response): Promise<void> => {
  const { ticketId } = req.params;
  const { approve, screenshotUrl, authorizedByDiscordId, authorizedByUsername } = req.body as {
    approve?: boolean;
    screenshotUrl?: string;
    authorizedByDiscordId?: string;
    authorizedByUsername?: string;
  };

  const community = req.community!;
  const ticket = await BankTicket.findOne({ _id: ticketId, communityId: community._id });
  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }
  if (ticket.status !== 'pending') {
    res.status(400).json({ error: `Ticket already ${ticket.status}` });
    return;
  }

  ticket.authorizedByDiscordId = authorizedByDiscordId;
  ticket.authorizedByUsername = authorizedByUsername;
  ticket.resolvedAt = new Date();

  if (!approve) {
    ticket.status = 'rejected';
    await ticket.save();
    res.json({ ticket, bankGp: community.bankGp });
    return;
  }

  if (!screenshotUrl) {
    res.status(400).json({ error: 'screenshotUrl is required to approve a ticket' });
    return;
  }

  if (ticket.type === 'deposit') {
    community.bankGp += ticket.amountGp;
  } else {
    if (ticket.amountGp > community.bankGp) {
      res.status(400).json({ error: 'Insufficient bank balance to complete this ticket.', bankGp: community.bankGp });
      return;
    }
    community.bankGp -= ticket.amountGp;
  }

  ticket.status = 'completed';
  ticket.screenshotUrl = screenshotUrl;
  await Promise.all([ticket.save(), community.save()]);
  res.json({ ticket, bankGp: community.bankGp });
});

export default router;
