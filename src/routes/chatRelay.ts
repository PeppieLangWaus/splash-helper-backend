import { Router, Request, Response } from 'express';
import { handleChatRelayPayload } from '../services/chatRelay';
import { log, logWarn } from '../utils/logger';
import { getClientIp } from '../utils/clientIp';

const router = Router();

/** Bounded, best-effort stringify for logging a rejected payload — never throws, never floods
 *  the log with a pathologically large message. */
function safeStringify(value: unknown, maxLength = 500): string {
  try {
    const json = JSON.stringify(value);
    return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
  } catch {
    return '<unserializable>';
  }
}

/**
 * POST /  (mounted at /chat-relay in app.ts; reached via chat.splasher.help and chat.ardy.host —
 * see nginx/splasher.help.conf)
 *
 * Deliberately unauthenticated: this is what the RuneLite chat-relay plugin posts straight to
 * from every player's client, in place of a Discord webhook URL. It carries no secret of its
 * own — anyone who knows a community's registered Friends/Clan Chat name could in principle post
 * as that community, so every message is format-checked and screened against that community's
 * block-list before being trusted. See services/chatRelay.ts for the full pipeline.
 *
 * Body is a single JSON object — one chat line per request — see RawChatRelayMessage for its
 * shape. Always responds 204 — including for a malformed or dropped message — so the plugin
 * (which doesn't meaningfully handle error responses) never surfaces this as a broken endpoint
 * to the player.
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(204).end();
    return;
  }

  const sourceIp = getClientIp(req);

  // Logged unconditionally (not just on failure) — this endpoint's wire format is still
  // stabilizing against whatever the plugin actually sends, so seeing every payload as it
  // arrives is far more useful right now than only seeing the ones that get rejected.
  log(`Chat relay payload from ${sourceIp}: ${safeStringify(body)}`);

  try {
    const result = await handleChatRelayPayload(body, sourceIp);
    // Duplicates are the expected common case (every member's client relays the same line) —
    // not worth logging every time the way a genuinely bad/blocked message is.
    if (result.status === 'dropped' && result.reason !== 'duplicate') {
      logWarn(`Chat relay dropped message from ${sourceIp}: ${result.reason}`);
    }
  } catch (err) {
    logWarn(`Chat relay error: ${(err as Error).message}`);
  }

  res.status(204).end();
});

export default router;
