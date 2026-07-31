import { Types } from 'mongoose';
import { ArchivedSession } from '../models/ArchivedSession';
import { BankTicket } from '../models/BankTicket';
import { getMapEntry } from './ranks';

/**
 * Sums `hours * hourlyRate` across every archived session this user has for the given
 * community, reading each session's frozen `earningsSnapshot` entry — mirrors the per-session
 * calculation already done in GET /communities/:id/sessions, just totalled across all of them.
 */
export async function computeTotalEarnedGp(userId: Types.ObjectId, communityId: Types.ObjectId): Promise<number> {
  const communityIdStr = communityId.toString();
  const sessions = await ArchivedSession.find(
    { userId },
    { earningsSnapshot: 1, createdTimestamp: 1, finalizedTimestamp: 1 },
  ).lean();

  return sessions.reduce((total, s) => {
    const earnings = getMapEntry<{ hourlyRate: number }>(s.earningsSnapshot, communityIdStr);
    if (!earnings) return total;
    const hours = (s.finalizedTimestamp - s.createdTimestamp) / 3_600_000;
    return total + hours * earnings.hourlyRate;
  }, 0);
}

/** Sums amountGp across every completed payout BankTicket this user has had paid out in this
 *  community. Rejected/pending payout tickets don't count — only a completed payout actually
 *  reduces what's still owed to the splasher. */
export async function computeTotalPaidOutGp(userId: Types.ObjectId, communityId: Types.ObjectId): Promise<number> {
  const tickets = await BankTicket.find(
    { communityId, requestedByUserId: userId, type: 'payout', status: 'completed' },
    { amountGp: 1 },
  ).lean();
  return tickets.reduce((total, t) => total + t.amountGp, 0);
}
