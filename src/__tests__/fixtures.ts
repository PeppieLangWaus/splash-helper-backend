import { SessionData, SplashEntry } from '../types';

export function makeSessionData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    playerName: 'TestPlayer',
    spell: 'WIND_STRIKE',
    runeCostPerCast: 2,
    startTime: new Date(Date.now() - 3_600_000).toISOString(),
    logoutTime: new Date().toISOString(),
    world: 302,
    stickyKnight: false,
    spellsCast: 1000,
    startMagicXp: 300_000,
    currentMagicXp: 302_000,
    knightMovements: 5,
    highestPlayerCount: 4,
    averagePlayerCount: 3.2,
    pickpocketerCount: 0,
    startingRuneCount: 5000,
    currentRuneCount: 3000,
    runeUsageMap: { '556': 1000 },
    runeCostGp: 4500,
    ...overrides,
  };
}

export function makeSplashEntry(overrides: Partial<SplashEntry> = {}): SplashEntry {
  const now = Date.now();
  return {
    sessionId: `session-${now}`,
    createdTimestamp: now,
    finalizedTimestamp: now + 3_600_000,
    syncedToServer: false,
    session: makeSessionData(),
    ...overrides,
  };
}
