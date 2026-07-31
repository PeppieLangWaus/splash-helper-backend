import { Router, Request, Response } from 'express';
import { Types } from 'mongoose';
import { requireAdmin } from '../middleware/auth';
import { User } from '../models/User';
import { ArchivedSession } from '../models/ArchivedSession';
import { Community } from '../models/Community';
import { SecurityEvent } from '../models/SecurityEvent';
import { assignDefaultRank } from '../services/ranks';

const router = Router();

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';

// All routes require admin JWT
router.use(requireAdmin);

/**
 * GET /api/admin/users
 * Returns all users (passwords excluded). Unlike GET /splashers/:username — which only ever
 * includes a user's plugin sync `token` when they're looking up their own data — admin routes
 * trust the requireAdmin JWT check and include every user's token here, so staff can look one
 * up for support (e.g. a splasher who lost theirs) without needing DB access.
 */
router.get('/users', async (_req: Request, res: Response): Promise<void> => {
  const users = await User.find({}, { passwordHash: 0 }).lean();
  res.json({ users });
});

/**
 * GET /api/admin/security-events
 * Read-only audit log of suspicious /community-bot/verify-setup attempts, for human review.
 */
router.get('/security-events', async (_req: Request, res: Response): Promise<void> => {
  const events = await SecurityEvent.find({}).sort({ createdAt: -1 }).lean();
  res.json({ events });
});

/**
 * POST /api/admin/promote/:username
 * Toggles isAdmin for the given user.
 * Requires X-Admin-Secret header matching ADMIN_SECRET env var.
 */
router.post('/promote/:username', async (req: Request, res: Response): Promise<void> => {
  const providedSecret = req.headers['x-admin-secret'];
  if (!ADMIN_SECRET || providedSecret !== ADMIN_SECRET) {
    res.status(403).json({ error: 'Invalid admin secret' });
    return;
  }

  const { username } = req.params;
  const user = await User.findOne({ username });
  if (!user) {
    res.status(404).json({ error: `User "${username}" not found` });
    return;
  }

  user.isAdmin = !user.isAdmin;
  await user.save();
  res.json({ message: `User "${username}" isAdmin set to ${user.isAdmin}`, isAdmin: user.isAdmin });
});

/**
 * DELETE /api/admin/users/:username
 * Removes a user and all their archived sessions.
 */
router.delete('/users/:username', async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;
  const user = await User.findOne({ username });
  if (!user) {
    res.status(404).json({ error: `User "${username}" not found` });
    return;
  }

  await ArchivedSession.deleteMany({ userId: user._id });
  await user.deleteOne();
  res.json({ message: `User "${username}" and all their sessions removed` });
});

/**
 * GET /api/admin/sessions
 * Returns all archived sessions across all users.
 */
router.get('/sessions', async (_req: Request, res: Response): Promise<void> => {
  const sessions = await ArchivedSession.find({}).lean();
  res.json({ sessions });
});

/**
 * DELETE /api/admin/sessions/:sessionId
 * Deletes a specific archived session by its MongoDB _id or sessionId field.
 */
router.delete('/sessions/:sessionId', async (req: Request, res: Response): Promise<void> => {
  const { sessionId } = req.params;
  const result = await ArchivedSession.findOneAndDelete({ sessionId });
  if (!result) {
    res.status(404).json({ error: `Session "${sessionId}" not found` });
    return;
  }
  res.json({ message: `Session "${sessionId}" deleted` });
});

/**
 * POST /api/admin/community-eligibility/:username
 * Toggles whether a user is allowed to set up a community.
 */
router.post('/community-eligibility/:username', async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;
  const user = await User.findOne({ username });
  if (!user) {
    res.status(404).json({ error: `User "${username}" not found` });
    return;
  }

  user.communityEligible = !user.communityEligible;
  await user.save();
  res.json({
    message: `User "${username}" communityEligible set to ${user.communityEligible}`,
    communityEligible: user.communityEligible,
  });
});

/**
 * GET /api/admin/communities
 * Returns all communities.
 */
router.get('/communities', async (_req: Request, res: Response): Promise<void> => {
  const communities = await Community.find({}).lean();
  res.json({ communities });
});

/**
 * DELETE /api/admin/communities/:communityId
 * Deletes a community. Does not delete its member/owner Users.
 */
router.delete('/communities/:communityId', async (req: Request, res: Response): Promise<void> => {
  const { communityId } = req.params;
  const result = await Community.findByIdAndDelete(communityId);
  if (!result) {
    res.status(404).json({ error: 'Community not found' });
    return;
  }
  res.json({ message: 'Community deleted' });
});

/**
 * POST /api/admin/communities/:communityId/members
 * Body: { usernames: string[] }
 * Bulk-assigns splashers to a community. Unknown usernames are skipped and
 * reported back in `notFound` rather than failing the whole request.
 */
router.post('/communities/:communityId/members', async (req: Request, res: Response): Promise<void> => {
  const { communityId } = req.params;
  const { usernames } = req.body as { usernames?: string[] };
  if (!Array.isArray(usernames) || usernames.length === 0) {
    res.status(400).json({ error: 'usernames must be a non-empty array' });
    return;
  }

  const community = await Community.findById(communityId);
  if (!community) {
    res.status(404).json({ error: 'Community not found' });
    return;
  }

  const users = await User.find({ username: { $in: usernames } });
  const foundUsernames = new Set(users.map((u) => u.username));
  const notFound = usernames.filter((username) => !foundUsernames.has(username));
  // Only newly-added members get defaulted onto the default rank — an existing member who
  // already has a custom rank assignment must not be reset by re-running a bulk assign.
  const newUsers = users.filter((u) => !community.memberUserIds.some((id) => id.equals(u._id)));

  if (users.length > 0) {
    await Community.updateOne(
      { _id: communityId },
      { $addToSet: { memberUserIds: { $each: users.map((u) => u._id) } } },
    );
    await Promise.all(
      newUsers.map(async (user) => {
        await assignDefaultRank(user, community._id as Types.ObjectId);
        await user.save();
      }),
    );
  }

  const updated = await Community.findById(communityId).lean();
  res.json({
    message: `${users.length} splasher${users.length === 1 ? '' : 's'} assigned to community "${community.name}"`,
    community: updated,
    notFound,
  });
});

/**
 * POST /api/admin/communities/:communityId/members/:username
 * Assigns a splasher to a community.
 */
router.post('/communities/:communityId/members/:username', async (req: Request, res: Response): Promise<void> => {
  const { communityId, username } = req.params;
  const community = await Community.findById(communityId);
  if (!community) {
    res.status(404).json({ error: 'Community not found' });
    return;
  }

  const user = await User.findOne({ username });
  if (!user) {
    res.status(404).json({ error: `User "${username}" not found` });
    return;
  }

  if (!community.memberUserIds.some((id) => id.equals(user._id))) {
    community.memberUserIds.push(user._id);
    await community.save();
    await assignDefaultRank(user, community._id as Types.ObjectId);
    await user.save();
  }
  res.json({ message: `User "${username}" assigned to community "${community.name}"` });
});

/**
 * DELETE /api/admin/communities/:communityId/members/:username
 * Removes a splasher from a community.
 */
router.delete('/communities/:communityId/members/:username', async (req: Request, res: Response): Promise<void> => {
  const { communityId, username } = req.params;
  const community = await Community.findById(communityId);
  if (!community) {
    res.status(404).json({ error: 'Community not found' });
    return;
  }

  const user = await User.findOne({ username }, { _id: 1 }).lean();
  if (!user) {
    res.status(404).json({ error: `User "${username}" not found` });
    return;
  }

  community.memberUserIds = community.memberUserIds.filter((id) => !id.equals(user._id));
  await community.save();
  res.json({ message: `User "${username}" removed from community "${community.name}"` });
});

export default router;
