import { Types } from 'mongoose';
import { Rank, IRank } from '../models/Rank';
import { IUser } from '../models/User';

/** Every community always has exactly one `isDefault` rank, created alongside the
 *  community itself. This lazily creates it if somehow missing (e.g. older data). */
export async function getOrCreateDefaultRank(communityId: Types.ObjectId): Promise<IRank> {
  const existing = await Rank.findOne({ communityId, isDefault: true });
  if (existing) return existing;
  return Rank.create({ communityId, name: 'Default', hourlyRate: 0, isDefault: true });
}

/** Sets a member's rank for one community on their `rankAssignments` map in memory —
 *  caller is responsible for `user.save()`. */
export function setMemberRank(user: IUser, communityId: Types.ObjectId, rankId: Types.ObjectId): void {
  if (!user.rankAssignments) user.rankAssignments = new Map();
  user.rankAssignments.set(communityId.toString(), rankId);
}

/** Assigns a newly-joined member the community's default rank. */
export async function assignDefaultRank(user: IUser, communityId: Types.ObjectId): Promise<void> {
  const rank = await getOrCreateDefaultRank(communityId);
  setMemberRank(user, communityId, rank._id as Types.ObjectId);
}

/** Reads one entry out of a Map-typed schema field, regardless of whether it arrived as an
 *  actual `Map` (a hydrated document) or a plain object (a `.lean()` query result — Mongoose
 *  stores Map fields as plain BSON subdocuments, so `.lean()` never reconstructs the Map). */
export function getMapEntry<V>(mapField: unknown, key: string): V | undefined {
  if (!mapField) return undefined;
  if (mapField instanceof Map) return mapField.get(key) as V | undefined;
  return (mapField as Record<string, V>)[key];
}
