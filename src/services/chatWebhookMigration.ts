import { Community } from '../models/Community';
import { log, logWarn } from '../utils/logger';

/**
 * One-time startup migration: `Community.discordChatWebhookUrl` (a single webhook shared by both
 * Friends Chat and Clan Chat relay forwarding) was replaced by two independent fields,
 * `discordFriendsChatWebhookUrl` / `discordClanChatWebhookUrl` — see services/chatRelay.ts. Any
 * community that had already set the old field gets it copied into whichever new field(s) aren't
 * already set, then the old field is cleared. Idempotent — communities with no legacy value, or
 * that have already been migrated, are left untouched (the `$exists` filter finds none).
 */
export async function migrateLegacyChatWebhooks(): Promise<void> {
  const legacy = await Community.find(
    { discordChatWebhookUrl: { $exists: true, $ne: null } },
    { discordChatWebhookUrl: 1, discordFriendsChatWebhookUrl: 1, discordClanChatWebhookUrl: 1 },
  );
  if (legacy.length === 0) return;

  for (const community of legacy) {
    const legacyUrl = community.discordChatWebhookUrl;
    if (!legacyUrl) continue;
    if (!community.discordFriendsChatWebhookUrl) community.discordFriendsChatWebhookUrl = legacyUrl;
    if (!community.discordClanChatWebhookUrl) community.discordClanChatWebhookUrl = legacyUrl;
    community.discordChatWebhookUrl = undefined;
    try {
      await community.save();
    } catch (err) {
      logWarn(`Failed to migrate legacy chat webhook for community ${community._id}: ${(err as Error).message}`);
    }
  }

  log(`Migrated legacy discordChatWebhookUrl for ${legacy.length} community(ies)`);
}
