import { Router, Request, Response } from 'express';
import { WebSocket } from 'ws';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import mongoose from 'mongoose';
import {
  get as getSession,
  set as setSession,
  remove as removeSession,
  clear as clearSessions,
  updateSessionData,
} from '../websocket/sessionManager';
import { randomFakeSessionData, randomFakeHistoricalSessions } from '../devtools/fakeSessionData';
import { User } from '../models/User';
import { ArchivedSession } from '../models/ArchivedSession';
import { ActiveSessionState } from '../types';
import { requireEnv } from '../config/env';

/**
 * Dev-only endpoints for injecting/removing fake active sessions without a
 * real RuneLite plugin connection. Mounted only when NODE_ENV !== 'production'
 * (see app.ts). Bypasses auth entirely. The active session lives only in the
 * in-memory sessionManager map, but adding one also seeds a matching fake
 * User + a batch of ArchivedSession history in the DB so the splasher's
 * profile page has data to show — removing the fake session cleans both up.
 */
const HISTORICAL_SESSION_COUNT = 5;
const JWT_SECRET = requireEnv('JWT_SECRET');

const router = Router();
const DEFAULT_DEV_ADMIN_USERNAME = 'DevAdmin';

/**
 * POST /dev/reset
 * Wipes every collection in the dev database and clears in-memory active
 * sessions, so `npm run dev:local`'s otherwise-persistent data (see
 * src/devtools/localServer.ts) can be blown away on demand instead of only
 * by deleting .devdata/mongo by hand. Meant to back a "Reset dev data"
 * button in the frontend's dev view — dev-only, mounted only when
 * NODE_ENV !== 'production' (see app.ts), no auth required.
 */
router.post('/reset', async (_req: Request, res: Response): Promise<void> => {
  clearSessions();

  const collections = mongoose.connection.collections;
  const cleared: string[] = [];
  for (const name of Object.keys(collections)) {
    await collections[name].deleteMany({});
    cleared.push(name);
  }

  res.json({ message: 'Dev data reset', collectionsCleared: cleared });
});

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

async function ensureFakeUser(username: string) {
  let user = await User.findOne({ username });
  if (!user) {
    const passwordHash = await bcrypt.hash(randomUUID(), 12);
    user = await User.create({
      username,
      passwordHash,
      token: randomUUID(),
      isAdmin: false,
      setupLinkUsed: true,
    });
  }
  return user;
}

// Sessions created here have no real socket; readyState CLOSED makes the
// shared `send()` helper in websocket/handlers.ts a no-op if ever invoked.
function fakeSocket(): WebSocket {
  return { readyState: WebSocket.CLOSED } as unknown as WebSocket;
}

router.post('/sessions', async (req: Request, res: Response): Promise<void> => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (!username) {
    res.status(400).json({ error: 'username is required' });
    return;
  }
  if (getSession(username)) {
    res.status(409).json({ error: `Fake session for "${username}" already exists` });
    return;
  }

  const user = await ensureFakeUser(username);

  const state: ActiveSessionState = {
    ws: fakeSocket(),
    username,
    userId: user._id.toString(),
    authenticated: true,
    sessionData: randomFakeSessionData(username),
    lastUpdate: Date.now(),
  };
  setSession(username, state);

  let historicalSessionsAdded = 0;
  try {
    const historical = randomFakeHistoricalSessions(username, HISTORICAL_SESSION_COUNT);
    const inserted = await ArchivedSession.insertMany(
      historical.map((h) => ({
        sessionId: h.sessionId,
        createdTimestamp: h.createdTimestamp,
        finalizedTimestamp: h.finalizedTimestamp,
        userId: user._id,
        username,
        session: h.session,
      })),
      { ordered: false },
    );
    historicalSessionsAdded = inserted.length;
  } catch (err) {
    console.error(`Failed to seed fake historical sessions for "${username}":`, err);
  }

  res.status(201).json({ username, sessionData: state.sessionData, historicalSessionsAdded });
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

router.delete('/sessions/:username', async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;
  if (!getSession(username)) {
    res.status(404).json({ error: `No fake session for "${username}"` });
    return;
  }
  removeSession(username);

  try {
    const user = await User.findOne({ username });
    if (user) {
      await ArchivedSession.deleteMany({ userId: user._id });
      await user.deleteOne();
    }
  } catch (err) {
    console.error(`Failed to clean up fake user/history for "${username}":`, err);
  }

  res.json({ message: `Removed fake session for "${username}"` });
});

export default router;
