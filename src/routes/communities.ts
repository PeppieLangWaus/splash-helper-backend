import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { User } from '../models/User';
import { Community } from '../models/Community';
import { ArchivedSession } from '../models/ArchivedSession';

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
 * Returns the splashers (Users) assigned to this community. Owner or admin only.
 */
router.get('/:communityId/splashers', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const splashers = await User.find(
    { _id: { $in: community.memberUserIds } },
    { passwordHash: 0 },
  ).lean();
  res.json({ splashers });
});

/**
 * GET /api/communities/:communityId/sessions
 * Returns archived sessions for every splasher assigned to this community.
 * Owner or admin only.
 */
router.get('/:communityId/sessions', async (req: Request, res: Response): Promise<void> => {
  const community = await loadOwnedCommunity(req, res);
  if (!community) return;

  const sessions = await ArchivedSession.find({ userId: { $in: community.memberUserIds } }).lean();
  res.json({ sessions });
});

export default router;
