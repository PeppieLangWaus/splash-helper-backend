import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { ArchivedSession } from '../models/ArchivedSession';
import { User } from '../models/User';
import { Community } from '../models/Community';
import { JwtPayload } from '../types';
import { getAll as getActiveSessions } from '../websocket/sessionManager';
import { resolveWebhookField } from '../services/discordWebhook';

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
 * Public - returns currently active sessions (in-memory, not from DB).
 */
router.get('/', (_req: Request, res: Response): void => {
  const active = getActiveSessions();
  const sessions = active
    .filter((s) => s.authenticated && s.sessionData !== null)
    .map((s) => ({
      username: s.username,
      sessionData: s.sessionData,
      lastUpdate: s.lastUpdate,
    }));
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

export default router;
