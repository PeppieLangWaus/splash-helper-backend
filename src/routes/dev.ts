import { Router, Request, Response } from 'express';
import { WebSocket } from 'ws';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import {
  get as getSession,
  set as setSession,
  remove as removeSession,
  updateSessionData,
} from '../websocket/sessionManager';
import { randomFakeSessionData } from '../devtools/fakeSessionData';
import { ActiveSessionState } from '../types';
import { User } from '../models/User';

/**
 * Dev-only endpoints for injecting/removing fake active sessions without a
 * real RuneLite plugin connection. Mounted only when NODE_ENV !== 'production'
 * (see app.ts). Bypasses auth and the database entirely — everything here
 * only touches the in-memory sessionManager map.
 */
const router = Router();
const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production';
const DEFAULT_DEV_ADMIN_USERNAME = 'DevAdmin';

/**
 * POST /dev/admin-token
 * Body: { username?: string }
 * Mints an admin + communityEligible JWT for the given username (default
 * "DevAdmin"), creating the User if it doesn't exist. Existing users only
 * have isAdmin/communityEligible flipped on — their token/passwordHash are
 * left untouched so this never breaks a real WebSocket (plugin) session for
 * that account. Bypasses password auth entirely; dev-only.
 */
router.post('/admin-token', async (req: Request, res: Response): Promise<void> => {
  const username = typeof req.body?.username === 'string' && req.body.username.trim()
    ? req.body.username.trim()
    : DEFAULT_DEV_ADMIN_USERNAME;

  let user = await User.findOne({ username });
  if (!user) {
    const passwordHash = await bcrypt.hash(randomUUID(), 12);
    user = await User.create({
      username,
      passwordHash,
      token: randomUUID(),
      isAdmin: true,
      setupLinkUsed: false,
      communityEligible: true,
    });
  } else if (!user.isAdmin || !user.communityEligible) {
    user.isAdmin = true;
    user.communityEligible = true;
    await user.save();
  }

  const payload = { sub: user.username, isAdmin: user.isAdmin, communityEligible: user.communityEligible };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username, isAdmin: user.isAdmin, communityEligible: user.communityEligible });
});

// Sessions created here have no real socket; readyState CLOSED makes the
// shared `send()` helper in websocket/handlers.ts a no-op if ever invoked.
function fakeSocket(): WebSocket {
  return { readyState: WebSocket.CLOSED } as unknown as WebSocket;
}

router.post('/sessions', (req: Request, res: Response): void => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (!username) {
    res.status(400).json({ error: 'username is required' });
    return;
  }
  if (getSession(username)) {
    res.status(409).json({ error: `Fake session for "${username}" already exists` });
    return;
  }

  const state: ActiveSessionState = {
    ws: fakeSocket(),
    username,
    authenticated: true,
    sessionData: randomFakeSessionData(username),
    lastUpdate: Date.now(),
  };
  setSession(username, state);
  res.status(201).json({ username, sessionData: state.sessionData });
});

router.post('/sessions/:username/tick', (req: Request, res: Response): void => {
  const { username } = req.params;
  const existing = getSession(username);
  if (!existing?.sessionData) {
    res.status(404).json({ error: `No fake session for "${username}"` });
    return;
  }

  const d = existing.sessionData;
  const newSpells = Math.floor(Math.random() * 20) + 1;
  updateSessionData(username, {
    ...d,
    spellsCast: d.spellsCast + newSpells,
    currentMagicXp: d.currentMagicXp + newSpells * 30,
    currentRuneCount: Math.max(0, d.currentRuneCount - newSpells * d.runeCostPerCast),
  });
  res.json({ username, sessionData: getSession(username)!.sessionData });
});

router.delete('/sessions/:username', (req: Request, res: Response): void => {
  const { username } = req.params;
  if (!getSession(username)) {
    res.status(404).json({ error: `No fake session for "${username}"` });
    return;
  }
  removeSession(username);
  res.json({ message: `Removed fake session for "${username}"` });
});

export default router;
