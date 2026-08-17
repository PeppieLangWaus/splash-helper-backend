import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { SetupLinkJwtPayload } from '../types';
import { requireEnv } from '../config/env';
import { rateLimit } from '../middleware/rateLimit';
import { requireAuth } from '../middleware/auth';
import { EmailVerificationToken } from '../models/EmailVerificationToken';
import { generateToken, hashToken } from '../utils/secureToken';
import { sendVerificationEmail, sendEmailChangedNotice } from '../services/email';

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_VERIFICATION_EXPIRY_MS = 24 * 60 * 60 * 1000;

const emailChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyFn: (req) => req.user?.sub ?? req.ip ?? 'unknown',
});

/**
 * POST /auth/email
 * Body: { email: string; currentPassword: string }
 * Attaches or replaces the caller's own email. Requires their current password as a second
 * factor, so a stolen JWT alone can't plant a backdoor recovery address. Always resets
 * emailVerifiedAt — even re-submitting the same address has to be re-verified — and sends a
 * fresh verification link. If a different, already-verified email is being replaced, also
 * notifies the old address, so a hijacker with temporary access can't quietly redirect recovery
 * without the real owner noticing.
 */
router.post('/email', requireAuth, emailChangeLimiter, async (req: Request, res: Response): Promise<void> => {
  const { email, currentPassword } = req.body as { email?: string; currentPassword?: string };

  if (!email || !currentPassword) {
    res.status(400).json({ error: 'email and currentPassword are required' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalizedEmail)) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }

  const user = await User.findOne({ username: req.user!.sub });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'Incorrect password' });
    return;
  }

  const previousVerifiedEmail = user.emailVerifiedAt ? user.email : undefined;

  user.email = normalizedEmail;
  user.emailVerifiedAt = undefined;
  try {
    await user.save();
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code?: number }).code === 11000) {
      res.status(409).json({ error: 'That email is already in use on another account' });
      return;
    }
    throw err;
  }

  await EmailVerificationToken.deleteMany({ userId: user._id });
  const { raw, hash } = generateToken();
  await EmailVerificationToken.create({
    userId: user._id,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MS),
  });

  await sendVerificationEmail(normalizedEmail, `${FRONTEND_URL}/verify-email?token=${raw}`);
  if (previousVerifiedEmail && previousVerifiedEmail !== normalizedEmail) {
    await sendEmailChangedNotice(previousVerifiedEmail);
  }

  res.json({ email: user.email, emailVerifiedAt: null, message: 'Verification email sent.' });
});

/**
 * GET /auth/verify-email/:token
 * Public — the token itself is the credential. Single use, 24h expiry.
 */
router.get('/verify-email/:token', async (req: Request, res: Response): Promise<void> => {
  const { token } = req.params;
  const record = await EmailVerificationToken.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } });
  if (!record) {
    res.status(400).json({ error: 'Invalid or expired link' });
    return;
  }

  const user = await User.findById(record.userId);
  if (!user) {
    res.status(400).json({ error: 'Invalid or expired link' });
    return;
  }

  user.emailVerifiedAt = new Date();
  await user.save();
  await EmailVerificationToken.deleteOne({ _id: record._id });

  res.json({ message: 'Email verified.' });
});

const resendVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  keyFn: (req) => req.user?.sub ?? req.ip ?? 'unknown',
});

/**
 * POST /auth/resend-verification
 * Re-sends a verification link for the caller's already-attached, still-unverified email. No
 * currentPassword needed — nothing about the account changes, this only resends.
 */
router.post('/resend-verification', requireAuth, resendVerificationLimiter, async (req: Request, res: Response): Promise<void> => {
  const user = await User.findOne({ username: req.user!.sub });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (!user.email) {
    res.status(400).json({ error: 'No email on file to verify' });
    return;
  }
  if (user.emailVerifiedAt) {
    res.status(400).json({ error: 'Email is already verified' });
    return;
  }

  await EmailVerificationToken.deleteMany({ userId: user._id });
  const { raw, hash } = generateToken();
  await EmailVerificationToken.create({
    userId: user._id,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MS),
  });

  await sendVerificationEmail(user.email, `${FRONTEND_URL}/verify-email?token=${raw}`);
  res.json({ message: 'Verification email sent.' });
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
