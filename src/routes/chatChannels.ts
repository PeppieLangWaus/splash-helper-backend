import { Router, Request, Response } from 'express';
import { ChatChannelName } from '../models/ChatChannelName';
import { Community } from '../models/Community';

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
      // `name` is null until this FC's first message has been relayed and self-synced (see
      // chatRelay.ts's syncFriendsChatIdentity) — a freshly owner-registered FC has none yet.
      entry.friendsChatName = n.name ?? null;
      entry.friendsChatDisplayName = n.displayName ?? null;
    } else {
      entry.clanChatName = n.name ?? null;
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

export default router;
