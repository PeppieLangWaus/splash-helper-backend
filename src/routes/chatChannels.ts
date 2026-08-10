import { Router, Request, Response } from 'express';
import { Types } from 'mongoose';
import { ChatChannelName } from '../models/ChatChannelName';
import { Community } from '../models/Community';
import { getRecentChatMessages, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from '../services/chatHistory';

const router = Router();

/**
 * GET /chat-channels
 * Public (no auth) — every community that has registered a Friends Chat and/or Clan Chat name,
 * for the frontend's live-chat community picker (splash-helper-frontend's Chatbox). Deliberately
 * separate from routes/communities.ts, which is entirely behind requireAuth — per-visitor chat
 * viewing has no login requirement, so this can't just be another route on that router. Only
 * communities with at least one registered name are listed; one with neither isn't watchable yet.
 */
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const names = await ChatChannelName.find({}).lean();
  if (names.length === 0) {
    res.json({ channels: [] });
    return;
  }

  const communityIds = [...new Set(names.map((n) => n.communityId.toString()))];
  const communities = await Community.find({ _id: { $in: communityIds } }, { name: 1 }).lean();
  const nameById = new Map(communities.map((c) => [c._id.toString(), c.name]));

  const byCommunity = new Map<
    string,
    { friendsChatName: string | null; friendsChatDisplayName: string | null; clanChatName: string | null }
  >();
  for (const n of names) {
    const id = n.communityId.toString();
    const entry = byCommunity.get(id) ?? { friendsChatName: null, friendsChatDisplayName: null, clanChatName: null };
    if (n.channelType === 'fc') {
      entry.friendsChatName = n.name;
      entry.friendsChatDisplayName = n.displayName ?? null;
    } else {
      entry.clanChatName = n.name;
    }
    byCommunity.set(id, entry);
  }

  const channels = [...byCommunity.entries()]
    // Guards against an orphaned ChatChannelName left behind if a community was ever deleted
    // without cleaning up its registrations.
    .filter(([id]) => nameById.has(id))
    .map(([id, entry]) => ({
      communityId: id,
      communityName: nameById.get(id)!,
      friendsChatName: entry.friendsChatName,
      friendsChatDisplayName: entry.friendsChatDisplayName,
      clanChatName: entry.clanChatName,
    }));

  res.json({ channels });
});

/**
 * GET /chat-channels/:communityId/:channelType/messages
 * Public (no auth) — same reasoning as the list above: per-visitor chat viewing has no login
 * requirement. Returns persisted history (see services/chatHistory.ts) for one community's FC or
 * CC feed, oldest first, so the frontend chatbox has something to render immediately on load
 * (including after a server restart) instead of waiting on the first live WebSocket message. The
 * live feed itself is still the WebSocket's CHAT_SUBSCRIBED/CHAT_MESSAGE flow
 * (websocket/chatBroadcast.ts) — this endpoint is purely for the initial backfill.
 */
router.get('/:communityId/:channelType/messages', async (req: Request, res: Response): Promise<void> => {
  const { communityId, channelType } = req.params;

  if (!Types.ObjectId.isValid(communityId)) {
    res.status(400).json({ error: 'Invalid communityId' });
    return;
  }
  if (channelType !== 'fc' && channelType !== 'cc') {
    res.status(400).json({ error: 'channelType must be "fc" or "cc"' });
    return;
  }

  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.floor(requestedLimit), MAX_HISTORY_LIMIT)
    : DEFAULT_HISTORY_LIMIT;

  const messages = await getRecentChatMessages(communityId, channelType, limit);
  res.json({ messages });
});

export default router;
