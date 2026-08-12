import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { ArchivedSession } from '../models/ArchivedSession';
import { User } from '../models/User';
import { Community } from '../models/Community';
import { SplasherVote, VoteValue } from '../models/SplasherVote';
import { JwtPayload } from '../types';
import { getAll as getActiveSessions } from '../websocket/sessionManager';
import { resolveWebhookField } from '../services/discordWebhook';
import { hashVoterIp } from '../utils/voterHash';

/**
 * A requester can view a target user's archived data if they are an admin,
 * are requesting their own data, or own a community that the target belongs to.
 */
async function canAccessSplasherData(requester: JwtPayload, targetUsername: string): Promise<boolean> {
  if (requester.isAdmin) return true;
  if (requester.sub === targetUsername) return true;

  const [requesterUser, targetUser] = await Promise.all([
    User.findOne({ username: requester.sub }, { _id: 1 }).lean(),
    User.findOne({ username: targetUsername }, { _id: 1 }).lean(),
  ]);
  if (!requesterUser || !targetUser) return false;

  const ownedCommunity = await Community.findOne({
    ownerIds: requesterUser._id,
    memberUserIds: targetUser._id,
  }).lean();
  return !!ownedCommunity;
}

const router = Router();

/**
 * GET /splashers
 * Public - returns currently active sessions (in-memory, not from DB). Each entry also lists
 * the splasher's community affiliation(s) that have a public Discord invite configured, so the
 * frontend can link their name out to their community's server. This is additive, not a
 * restriction: the feed itself stays fully public, same as before — only rate/rank data and
 * archived history remain behind community-token/JWT auth.
 */
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const active = getActiveSessions();
  const authenticated = active.filter((s) => s.authenticated && s.sessionData !== null);

  const users = await User.find(
    { username: { $in: authenticated.map((s) => s.username) } },
    { _id: 1, username: 1 },
  ).lean();
  const userIdByUsername = new Map(users.map((u) => [u.username, u._id]));

  const communities = await Community.find(
    { memberUserIds: { $in: users.map((u) => u._id) }, discordInviteUrl: { $exists: true, $nin: [null, ''] } },
    { name: 1, memberUserIds: 1, discordInviteUrl: 1 },
  ).lean();

  const sessions = authenticated.map((s) => {
    const userId = userIdByUsername.get(s.username);
    const memberCommunities = userId
      ? communities.filter((c) => c.memberUserIds.some((id) => id.equals(userId)))
      : [];
    return {
      username: s.username,
      sessionData: s.sessionData,
      lastUpdate: s.lastUpdate,
      communities: memberCommunities.map((c) => ({
        communityId: c._id,
        communityName: c.name,
        discordInviteUrl: c.discordInviteUrl,
      })),
    };
  });
  res.json({ sessions });
});

/**
 * GET /splashers/:username
 * Authenticated - returns archived sessions for the given username.
 * Regular users may only access their own data.
 * Admins may access any user data.
 */
router.get('/:username', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;
  const requester = req.user!;

  if (!(await canAccessSplasherData(requester, username))) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  const user = await User.findOne({ username }, { passwordHash: 0 }).lean();
  if (!user) {
    res.status(404).json({ error: `User "${username}" not found` });
    return;
  }

  const sessions = await ArchivedSession.find({ username }).lean();
  res.json({
    username,
    sessions,
    discordActiveWebhookUrl: user.discordActiveWebhookUrl,
    discordHistoryWebhookUrl: user.discordHistoryWebhookUrl,
    // The plugin sync token is only ever included for the splasher viewing their own data —
    // never when a community owner is looking up one of their members through this same route.
    token: requester.sub === username ? user.token : undefined,
  });
});

/**
 * PUT /splashers/:username/webhook
 * Body: { activeWebhookUrl?: string | null; historyWebhookUrl?: string | null }
 * Sets or clears this splasher's own Discord webhooks — additive with any community
 * webhook(s) they belong to. Same access rule as GET /splashers/:username: self, admin,
 * or the owner of a community the splasher belongs to.
 */
router.put('/:username/webhook', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;
  const requester = req.user!;

  if (!(await canAccessSplasherData(requester, username))) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  const user = await User.findOne({ username });
  if (!user) {
    res.status(404).json({ error: `User "${username}" not found` });
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

  if (activeUpdate.action === 'set') user.discordActiveWebhookUrl = activeUpdate.value;
  else if (activeUpdate.action === 'clear') user.discordActiveWebhookUrl = undefined;

  if (historyUpdate.action === 'set') user.discordHistoryWebhookUrl = historyUpdate.value;
  else if (historyUpdate.action === 'clear') user.discordHistoryWebhookUrl = undefined;

  await user.save();
  res.json({
    username: user.username,
    discordActiveWebhookUrl: user.discordActiveWebhookUrl,
    discordHistoryWebhookUrl: user.discordHistoryWebhookUrl,
  });
});

const voteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });

async function getVoteCounts(username: string): Promise<{ likes: number; dislikes: number }> {
  const [likes, dislikes] = await Promise.all([
    SplasherVote.countDocuments({ splasherUsername: username, value: 1 }),
    SplasherVote.countDocuments({ splasherUsername: username, value: -1 }),
  ]);
  return { likes, dislikes };
}

/**
 * GET /splashers/:username/votes
 * Public - returns like/dislike totals for a splasher, plus the requester's own vote (if any),
 * so the frontend can render the like/dislike buttons in the right state without an account.
 */
router.get('/:username/votes', async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;
  const voterHash = hashVoterIp(req.ip ?? 'unknown');

  const [{ likes, dislikes }, myVote] = await Promise.all([
    getVoteCounts(username),
    SplasherVote.findOne({ splasherUsername: username, voterHash }, { value: 1 }).lean(),
  ]);

  res.json({ username, likes, dislikes, myVote: myVote?.value ?? null });
});

/**
 * PUT /splashers/:username/vote
 * Public - like or dislike a splasher. Body: { value: 1 | -1 }.
 * No login required; a voter is identified by a hash of their IP (see utils/voterHash.ts),
 * and the unique index on SplasherVote guarantees at most one vote per voter per splasher —
 * voting again with the same value retracts it, voting with the other value switches it.
 */
router.put('/:username/vote', voteLimiter, async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;
  const { value } = req.body as { value?: unknown };

  if (value !== 1 && value !== -1) {
    res.status(400).json({ error: 'value must be 1 (like) or -1 (dislike)' });
    return;
  }

  const user = await User.findOne({ username }, { _id: 1 }).lean();
  if (!user) {
    res.status(404).json({ error: `User "${username}" not found` });
    return;
  }

  const voterHash = hashVoterIp(req.ip ?? 'unknown');
  const existing = await SplasherVote.findOne({ splasherUsername: username, voterHash }, { value: 1 }).lean();

  let myVote: VoteValue | null;
  if (existing?.value === value) {
    await SplasherVote.deleteOne({ splasherUsername: username, voterHash });
    myVote = null;
  } else {
    await SplasherVote.updateOne(
      { splasherUsername: username, voterHash },
      { $set: { value } },
      { upsert: true },
    );
    myVote = value;
  }

  const { likes, dislikes } = await getVoteCounts(username);
  res.json({ username, likes, dislikes, myVote });
});

export default router;
