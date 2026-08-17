import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { SetupLinkJwtPayload } from '../types';
import { requireEnv } from '../config/env';
import { rateLimit } from '../middleware/rateLimit';

const router = Router();
const JWT_SECRET = requireEnv('JWT_SECRET');
const SETUP_LINK_SECRET = process.env.SETUP_LINK_SECRET ?? JWT_SECRET;
const SETUP_LINK_EXPIRY = (process.env.SETUP_LINK_EXPIRY ?? '24h') as `${number}${'s'|'m'|'h'|'d'}` | undefined;
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';
// Both optional: if either is unset (e.g. local dev without the shortener running),
// generateSetupLink() just returns the long URL instead of calling out.
const SHORTENER_API_URL = process.env.SHORTENER_API_URL;
const SHORTENER_API_KEY = process.env.SHORTENER_API_KEY;
const SHORTENER_TIMEOUT_MS = 2500;

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

  const payload = { sub: user.username, isAdmin: user.isAdmin, communityEligible: user.communityEligible, tv: user.tokenVersion };
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

  const jwtPayload = { sub: user.username, isAdmin: user.isAdmin, communityEligible: user.communityEligible, tv: user.tokenVersion };
  const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '7d' });
  res.json({ message: 'Account set up successfully', token, username: user.username, isAdmin: user.isAdmin, communityEligible: user.communityEligible });
});

/**
 * Generates a signed setup link JWT for a given username, then tries to shrink it
 * via the Ardy Host URL shortener (splasher.help/setup?token=... -> link.ardy.host/<user>)
 * so it's actually usable pasted into a RuneLite chatbox. The shortener is a separate,
 * independently-deployed service — if it's unreachable, misconfigured, or simply not
 * set up (SHORTENER_API_URL/SHORTENER_API_KEY unset), this always falls back to the
 * long URL rather than letting a shortener outage block account setup.
 * Called internally by the WebSocket AUTH handler.
 */
export async function generateSetupLink(username: string): Promise<string> {
  const payload: SetupLinkJwtPayload = { purpose: 'account-setup', username };
  const token = jwt.sign(payload, SETUP_LINK_SECRET, { expiresIn: SETUP_LINK_EXPIRY ?? '24h' });
  const longUrl = `${FRONTEND_URL}/setup?token=${token}`;

  if (!SHORTENER_API_URL || !SHORTENER_API_KEY) {
    return longUrl;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHORTENER_TIMEOUT_MS);
  try {
    const response = await fetch(SHORTENER_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': SHORTENER_API_KEY },
      body: JSON.stringify({ url: longUrl }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`shortener responded ${response.status}`);
    }

    const data = (await response.json()) as { shortUrl?: string };
    if (!data.shortUrl) {
      throw new Error('shortener response missing shortUrl');
    }
    return data.shortUrl;
  } catch (err) {
    console.error('generateSetupLink: falling back to long URL, shortener call failed:', err);
    return longUrl;
  } finally {
    clearTimeout(timeout);
  }
}

export default router;
