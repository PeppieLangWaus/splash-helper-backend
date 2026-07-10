import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { User } from '../models/User';
import { ArchivedSession } from '../models/ArchivedSession';

const router = Router();

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';

// All routes require admin JWT
router.use(requireAdmin);

/**
 * GET /api/admin/users
 * Returns all users (passwords excluded).
 */
router.get('/users', async (_req: Request, res: Response): Promise<void> => {
  const users = await User.find({}, { passwordHash: 0 }).lean();
  res.json({ users });
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

export default router;
