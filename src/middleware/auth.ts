import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types';
import { requireEnv } from '../config/env';
import { Community } from '../models/Community';
import { User } from '../models/User';

const JWT_SECRET = requireEnv('JWT_SECRET');

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7);
  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // A password reset bumps the user's live tokenVersion — comparing it against the value this
  // JWT was issued with instantly invalidates every session token minted before the reset, not
  // just ones that happen to expire naturally over the following days.
  const user = await User.findOne({ username: payload.sub }, { tokenVersion: 1 });
  if (!user || user.tokenVersion !== (payload.tv ?? 0)) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  req.user = payload;
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  await requireAuth(req, res, () => {
    if (!req.user?.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  });
}

/**
 * Authenticates a request as belonging to a specific community, via the `X-Community-Token`
 * header matched against that community's `apiToken`. Used by every `/api/community-bot/*`
 * route (the Discord bot's ongoing per-guild calls) so handlers can trust `req.community`
 * without ever taking a community id from the request body/params.
 */
export async function requireCommunityToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers['x-community-token'];
  if (typeof token !== 'string' || !token.trim()) {
    res.status(401).json({ error: 'Community API token required' });
    return;
  }

  const community = await Community.findOne({ apiToken: token.trim() });
  if (!community) {
    res.status(401).json({ error: 'Invalid community API token' });
    return;
  }

  req.community = community;
  next();
}
