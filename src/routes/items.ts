import { Router, Request, Response } from 'express';
import { existsSync } from 'fs';
import path from 'path';

const router = Router();

// Populated by `npm run render-item-icons` (scripts/render-item-icons.ts) — a headless renderer
// (scripts/item-icons) reads a real OSRS cache and produces one {itemId}.png per named item,
// copied here and committed. See scripts/item-icons/README.md for what that pipeline does and why.
const ICONS_DIR = path.join(__dirname, '..', '..', 'data', 'item-icons');

/**
 * GET /items/:id/icon
 * Public (no auth) — item icons are non-sensitive public game data, same reasoning as
 * routes/chatChannels.ts. Consumers (the frontend chatbox) resolve an item ID out of a chat
 * message themselves (e.g. the `!log` command's `<img=N>` tags) and fetch its icon here; the
 * backend does no text parsing of its own.
 */
router.get('/:id/icon', (req: Request, res: Response): void => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) {
    res.status(400).json({ error: 'invalid item id' });
    return;
  }

  const filePath = path.join(ICONS_DIR, `${id}.png`);
  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // Icons are keyed by item ID within one rendered cache version and never change in place — a
  // re-render always overwrites the file wholesale rather than mutating it — so this is as
  // immutable as the rank icon URLs already hotlinked elsewhere.
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('png');
  res.sendFile(filePath);
});

export default router;
