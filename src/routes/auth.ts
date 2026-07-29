import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'crypto';
import { User } from '../models/User';
import { SetupLinkJwtPayload } from '../types';
import { requireEnv } from '../config/env';
import { rateLimit } from '../middleware/rateLimit';

const router = Router();
const JWT_SECRET = requireEnv('JWT_SECRET');
const SETUP_LINK_SECRET = process.env.SETUP_LINK_SECRET ?? JWT_SECRET;
const SETUP_LINK_EXPIRY = (process.env.SETUP_LINK_EXPIRY ?? '24h') as `${number}${'s'|'m'|'h'|'d'}` | undefined;
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

/**
 * POST /auth/login
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

  const payload = { sub: user.username, isAdmin: user.isAdmin, communityEligible: user.communityEligible };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username, isAdmin: user.isAdmin, communityEligible: user.communityEligible });
});

/**
 * POST /auth/setup/:setupToken
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

  const jwtPayload = { sub: user.username, isAdmin: user.isAdmin, communityEligible: user.communityEligible };
  const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '7d' });
  res.json({ message: 'Account set up successfully', token, username: user.username, isAdmin: user.isAdmin, communityEligible: user.communityEligible });
});

const resetPasswordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * POST /auth/reset-password
 * Body: { username: string; token: string; newPassword: string }
 * The plugin-held sync token doubles as proof of account ownership, so a user who forgot
 * their web password (but still has their RuneLite token) can reset it without any email
 * infrastructure or admin intervention.
 */
router.post('/reset-password', resetPasswordLimiter, async (req: Request, res: Response): Promise<void> => {
  const { username, token, newPassword } = req.body as { username?: string; token?: string; newPassword?: string };

  if (!username || !token || !newPassword) {
    res.status(400).json({ error: 'username, token, and newPassword are required' });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const user = await User.findOne({ username });
  if (!user || !tokensMatch(user.token, token)) {
    res.status(401).json({ error: 'Invalid username or token' });
    return;
  }

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  await user.save();

  const jwtPayload = { sub: user.username, isAdmin: user.isAdmin, communityEligible: user.communityEligible };
  const jwtToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '7d' });
  res.json({
    message: 'Password reset successfully',
    token: jwtToken,
    username: user.username,
    isAdmin: user.isAdmin,
    communityEligible: user.communityEligible,
  });
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
