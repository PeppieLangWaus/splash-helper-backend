import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { User } from '../models/User';
import { ArchivedSession } from '../models/ArchivedSession';
import { SplashEntry } from '../types';
import { enqueueWebhookNotification } from '../services/discordWebhook';
import { MIN_ARCHIVABLE_SESSION_DURATION_MS } from '../websocket/handlers';
import { requireAuth } from '../middleware/auth';

const router = Router();

/**
 * POST /sessions/upload
 * Accepts a JSON array of SplashEntry objects in the request body — the Account Settings
 * "import sessions" feature, restoring a splasher's own exported history.
 *
 * A regular user may only upload entries for their own username; entries for anyone else are
 * skipped, and users are never auto-created for them. Admins may upload for any player
 * (auto-creating the User if needed) — the original manual-testing behavior.
 */
router.post('/upload', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!Array.isArray(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'Request body must be a non-empty JSON array of session entries' });
      return;
    }

    const entries = req.body as SplashEntry[];
    const requester = req.user!;
    const addedByPlayer: Record<string, SplashEntry[]> = {};
    let skipped = 0;

    for (const entry of entries) {
      if (!entry?.sessionId || !entry?.session?.playerName) {
        skipped++;
        continue;
      }

      if (entry.finalizedTimestamp - entry.createdTimestamp < MIN_ARCHIVABLE_SESSION_DURATION_MS) {
        skipped++;
        continue;
      }

      const username = entry.session.playerName;
      if (!requester.isAdmin && username !== requester.sub) {
        skipped++;
        continue;
      }

      let user = await User.findOne({ username });
      if (!user) {
        if (!requester.isAdmin) {
          skipped++;
          continue;
        }
        const token = randomUUID();
        const passwordHash = await bcrypt.hash(randomUUID(), 12);
        user = await User.create({ username, passwordHash, token, isAdmin: false, setupLinkUsed: false });
      }

      // One archived session per (user, startTime) — matches the unique index, and the
      // live WebSocket archiving path's dedupe-by-session-start behavior.
      const duplicate = await ArchivedSession.exists({
        userId: user._id,
        createdTimestamp: entry.createdTimestamp,
      });

      if (duplicate) {
        skipped++;
        continue;
      }

      await ArchivedSession.create({
        sessionId: entry.sessionId,
        createdTimestamp: entry.createdTimestamp,
        finalizedTimestamp: entry.finalizedTimestamp,
        userId: user._id,
        username,
        session: entry.session,
      });

      if (!addedByPlayer[username]) addedByPlayer[username] = [];
      addedByPlayer[username].push(entry);
    }

    const webhookUrl = process.env.DISCORD_ARCHIVED_WEBHOOK_URL ?? '';
    for (const [username, sessions] of Object.entries(addedByPlayer)) {
      enqueueWebhookNotification(webhookUrl, username, sessions);
    }

    const totalAdded = Object.values(addedByPlayer).reduce((sum, s) => sum + s.length, 0);
    res.status(201).json({
      message: `Processed ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}: ${totalAdded} added, ${skipped} skipped`,
      added: totalAdded,
      skipped,
      addedByPlayer,
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
