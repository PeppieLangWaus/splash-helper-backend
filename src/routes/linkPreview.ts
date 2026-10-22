import { Router, Request, Response } from 'express';
import { getLinkPreview } from '../services/linkPreview';

const router = Router();

/**
 * GET /link-preview?url=...
 * Public (no auth) — same reasoning as routes/items.ts: this only ever returns non-sensitive
 * public data (an OSRS Wiki article's intro, a Discord guild's public invite info, or a RuneLite
 * Plugin Hub listing's GitHub repo info), and the frontend calls it for anyone hovering such a
 * link, logged in or not.
 *
 * `url` must be exactly the link being previewed (not just a title/code) — getLinkPreview() does
 * its own domain allowlisting, so a url outside that allowlist (or malformed) comes back as
 * `{ type: 'unsupported' }` rather than a 4xx, letting the frontend just render a plain link.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const url = req.query.url;
  if (typeof url !== 'string' || !url) {
    res.status(400).json({ error: 'url query parameter is required' });
    return;
  }

  const preview = await getLinkPreview(url);
  res.json(preview);
});

export default router;
