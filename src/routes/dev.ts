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
import { randomFakeSessionData, randomFakeHistoricalSessions } from '../devtools/fakeSessionData';
import { User } from '../models/User';
import { ArchivedSession } from '../models/ArchivedSession';
import { ActiveSessionState } from '../types';

/**
 * Dev-only endpoints for injecting/removing fake active sessions without a
 * real RuneLite plugin connection. Mounted only when NODE_ENV !== 'production'
 * (see app.ts). Bypasses auth entirely. The active session lives only in the
 * in-memory sessionManager map, but adding one also seeds a matching fake
 * User + a batch of ArchivedSession history in the DB so the splasher's
 * profile page has data to show — removing the fake session cleans both up.
 */
const HISTORICAL_SESSION_COUNT = 5;
const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production';
const DEV_ADMIN_USERNAME = 'dev-admin';

const router = Router();

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

/**
 * POST /dev/admin-token
 * Mints a JWT for a standing dev-only admin user (creating it on first call),
 * so the frontend can skip the login screen and land admin-side automatically.
 */
router.post('/admin-token', async (_req: Request, res: Response): Promise<void> => {
  let user = await User.findOne({ username: DEV_ADMIN_USERNAME });
  if (!user) {
    const passwordHash = await bcrypt.hash(randomUUID(), 12);
    user = await User.create({
      username: DEV_ADMIN_USERNAME,
      passwordHash,
      token: randomUUID(),
      isAdmin: true,
      setupLinkUsed: true,
    });
  } else if (!user.isAdmin) {
    user.isAdmin = true;
    await user.save();
  }

  const payload = { sub: user.username, isAdmin: true };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username, isAdmin: true });
});

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

  const state: ActiveSessionState = {
    ws: fakeSocket(),
    username,
    authenticated: true,
    sessionData: randomFakeSessionData(username),
    lastUpdate: Date.now(),
  };
  setSession(username, state);

  let historicalSessionsAdded = 0;
  try {
    const user = await ensureFakeUser(username);
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
