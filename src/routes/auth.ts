import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { SetupLinkJwtPayload } from '../types';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production';
const SETUP_LINK_SECRET = process.env.SETUP_LINK_SECRET ?? JWT_SECRET;
const SETUP_LINK_EXPIRY = (process.env.SETUP_LINK_EXPIRY ?? '24h') as `${number}${'s'|'m'|'h'|'d'}` | undefined;
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

/**
 * POST /api/auth/login
 * Body: { username: string; password: string }
 * Returns: { token: string }
 */
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }

  const user = await User.findOne({ username });
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const payload = { sub: user.username, isAdmin: user.isAdmin };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username, isAdmin: user.isAdmin });
});

/**
 * POST /api/auth/setup/:setupToken
 * Body: { password: string }
 * Validates the signed setup JWT, sets the user's password, marks the link as used.
 */
router.post('/setup/:setupToken', async (req: Request, res: Response): Promise<void> => {
  const { setupToken } = req.params;
  const { password } = req.body as { password?: string };

  if (!password || password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  let payload: SetupLinkJwtPayload;
  try {
    payload = jwt.verify(setupToken, SETUP_LINK_SECRET) as SetupLinkJwtPayload;
  } catch {
    res.status(400).json({ error: 'Setup link is invalid or has expired' });
    return;
  }

  if (payload.purpose !== 'account-setup') {
    res.status(400).json({ error: 'Invalid setup token purpose' });
    return;
  }

  const user = await User.findOne({ username: payload.username });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (user.setupLinkUsed) {
    res.status(400).json({ error: 'Setup link has already been used' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  user.passwordHash = passwordHash;
  user.setupLinkUsed = true;
  await user.save();

  const jwtPayload = { sub: user.username, isAdmin: user.isAdmin };
  const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '7d' });
  res.json({ message: 'Account set up successfully', token, username: user.username });
});

/**
 * Generates a signed setup link JWT for a given username.
 * Called internally by the WebSocket AUTH handler.
 */
export function generateSetupLink(username: string): string {
  const payload: SetupLinkJwtPayload = { purpose: 'account-setup', username };
  const token = jwt.sign(payload, SETUP_LINK_SECRET, { expiresIn: SETUP_LINK_EXPIRY ?? '24h' });
  return `${FRONTEND_URL}/setup?token=${token}`;
}

export default router;
