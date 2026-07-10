import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { ArchivedSession } from '../models/ArchivedSession';
import { User } from '../models/User';
import { getAll as getActiveSessions } from '../websocket/sessionManager';

const router = Router();

/**
 * GET /api/splashers
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
 * GET /api/splashers/:username
 * Authenticated - returns archived sessions for the given username.
 * Regular users may only access their own data.
 * Admins may access any user data.
 */
router.get('/:username', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;
  const requester = req.user!;

  if (!requester.isAdmin && requester.sub !== username) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  const user = await User.findOne({ username }, { passwordHash: 0 }).lean();
  if (!user) {
    res.status(404).json({ error: `User "${username}" not found` });
    return;
  }

  const sessions = await ArchivedSession.find({ username }).lean();
  res.json({ username, sessions });
});

export default router;
