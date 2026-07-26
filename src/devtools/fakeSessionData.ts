import { randomUUID } from 'crypto';
import { SessionData } from '../types';

const SPELLS = ['WIND_STRIKE', 'WATER_STRIKE', 'EARTH_STRIKE', 'FIRE_STRIKE'];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomFakeSessionData(username: string, overrides: Partial<SessionData> = {}): SessionData {
  const startedMinutesAgo = randomInt(1, 90);
  const startTime = new Date(Date.now() - startedMinutesAgo * 60_000);
  const spellsCast = randomInt(50, 3000);
  const runeCostPerCast = 2;

  return {
    playerName: username,
    spell: SPELLS[randomInt(0, SPELLS.length - 1)],
    runeCostPerCast,
    startTime: startTime.toISOString(),
    logoutTime: new Date().toISOString(),
    world: randomInt(300, 550),
    stickyKnight: Math.random() > 0.5,
    spellsCast,
    startMagicXp: 300_000,
    currentMagicXp: 300_000 + spellsCast * 30,
    knightMovements: randomInt(0, 30),
    highestPlayerCount: randomInt(0, 8),
    averagePlayerCount: Number((Math.random() * 6).toFixed(1)),
    pickpocketerCount: randomInt(0, 4),
    startingRuneCount: 10_000,
    currentRuneCount: Math.max(0, 10_000 - spellsCast * runeCostPerCast),
    runeUsageMap: { '556': spellsCast },
    runeCostGp: spellsCast * runeCostPerCast * 4,
    ...overrides,
  };
}

export interface FakeArchivedSessionRecord {
  sessionId: string;
  createdTimestamp: number;
  finalizedTimestamp: number;
  session: SessionData;
}

/**
 * Generates finished, already-archived-looking sessions spread across the
 * past month, for seeding a fake user's session history in dev mode.
 */
export function randomFakeHistoricalSessions(username: string, count = 5): FakeArchivedSessionRecord[] {
  const records: FakeArchivedSessionRecord[] = [];

  for (let i = 0; i < count; i++) {
    const daysAgo = randomInt(1, 30);
    const durationMinutes = randomInt(15, 180);
    const startTime = new Date(Date.now() - daysAgo * 24 * 60 * 60_000 - durationMinutes * 60_000);
    const endTime = new Date(startTime.getTime() + durationMinutes * 60_000);
    const spellsCast = randomInt(100, 5000);
    const runeCostPerCast = 2;

    const session = randomFakeSessionData(username, {
      startTime: startTime.toISOString(),
      logoutTime: endTime.toISOString(),
      endTime: endTime.toISOString(),
      spellsCast,
      currentMagicXp: 300_000 + spellsCast * 30,
      currentRuneCount: Math.max(0, 10_000 - spellsCast * runeCostPerCast),
      runeUsageMap: { '556': spellsCast },
      runeCostGp: spellsCast * runeCostPerCast * 4,
    });

    records.push({
      sessionId: randomUUID(),
      createdTimestamp: startTime.getTime(),
      finalizedTimestamp: endTime.getTime(),
      session,
    });
  }

  return records;
}
