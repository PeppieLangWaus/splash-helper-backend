import { Router, Request, Response } from 'express';
import { WebSocket } from 'ws';
import {
  get as getSession,
  set as setSession,
  remove as removeSession,
  updateSessionData,
} from '../websocket/sessionManager';
import { randomFakeSessionData } from '../devtools/fakeSessionData';
import { ActiveSessionState } from '../types';

/**
 * Dev-only endpoints for injecting/removing fake active sessions without a
 * real RuneLite plugin connection. Mounted only when NODE_ENV !== 'production'
 * (see app.ts). Bypasses auth and the database entirely — everything here
 * only touches the in-memory sessionManager map.
 */
const router = Router();

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
