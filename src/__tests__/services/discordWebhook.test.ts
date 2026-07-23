/**
 * discordWebhook.test.ts
 *
 * We reset the module registry before each test so each test gets a fresh
 * queue state.  After resetModules() we re-require BOTH discord.js (to get
 * the newly-mocked instance) AND the service (so its internal require resolves
 * to that same mock).
 */

let enqueueWebhookNotification: (url: string, username: string, entries: unknown[]) => void;
let upsertArchivedSessionNotification: (
  url: string,
  username: string,
  entry: ReturnType<typeof makeEntry>,
  existingMessageId?: string,
) => Promise<string | undefined>;
let mockSend: jest.Mock;
let mockEditMessage: jest.Mock;

// Fixtures helper - inline to avoid cross-module issues after resetModules
function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sid-' + Math.random(),
    createdTimestamp: Date.now(),
    finalizedTimestamp: Date.now() + 1000,
    syncedToServer: false,
    session: {
      playerName: 'TestPlayer',
      spell: 'WIND_STRIKE',
      runeCostPerCast: 2,
      startTime: new Date().toISOString(),
      logoutTime: new Date().toISOString(),
      world: 302,
      stickyKnight: false,
      spellsCast: 100,
      startMagicXp: 300000,
      currentMagicXp: 302000,
      knightMovements: 5,
      highestPlayerCount: 4,
      averagePlayerCount: 3.2,
      pickpocketerCount: 0,
      startingRuneCount: 5000,
      currentRuneCount: 3000,
      runeUsageMap: { '556': 100 },
      runeCostGp: 200,
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetModules();

  mockSend = jest.fn().mockResolvedValue({ id: 'new-msg-id' });
  mockEditMessage = jest.fn().mockResolvedValue({ id: 'edited-msg-id' });

  jest.mock('discord.js', () => {
    // Minimal EmbedBuilder stub that supports the chaining API
    class EmbedBuilder {
      data: Record<string, unknown> = {};
      setTitle(t: string) { this.data.title = t; return this; }
      setColor(c: number) { this.data.color = c; return this; }
      addFields(...f: unknown[]) { this.data.fields = f; return this; }
      setFooter(f: unknown) { this.data.footer = f; return this; }
      setTimestamp(d?: Date) { this.data.timestamp = d; return this; }
    }
    return {
      WebhookClient: jest.fn().mockImplementation(() => ({ send: mockSend, editMessage: mockEditMessage })),
      EmbedBuilder,
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require('../../services/discordWebhook') as typeof import('../../services/discordWebhook');
  enqueueWebhookNotification = svc.enqueueWebhookNotification as (url: string, username: string, entries: unknown[]) => void;
  upsertArchivedSessionNotification = svc.upsertArchivedSessionNotification;
});

afterEach(() => {
  jest.clearAllMocks();
});

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('enqueueWebhookNotification', () => {
  it('does nothing when webhookUrl is empty', async () => {
    enqueueWebhookNotification('', 'Player', [makeEntry()]);
    await flushPromises();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does nothing when entries array is empty', async () => {
    enqueueWebhookNotification('https://discord.com/api/webhooks/123/abc', 'Player', []);
    await flushPromises();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends a single call for up to 10 entries', async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ sessionId: `s${i}`, createdTimestamp: i * 1000, finalizedTimestamp: i * 1000 + 500 }),
    );
    enqueueWebhookNotification('https://discord.com/api/webhooks/123/abc', 'Player', entries);
    await flushPromises();
    expect(mockSend).toHaveBeenCalledTimes(1);
    const body = mockSend.mock.calls[0][0] as { embeds: unknown[] };
    expect(body.embeds).toHaveLength(5);
  });

  it('chunks entries into groups of 10', async () => {
    const entries = Array.from({ length: 25 }, (_, i) =>
      makeEntry({ sessionId: `s${i}`, createdTimestamp: i * 1000, finalizedTimestamp: i * 1000 + 500 }),
    );
    enqueueWebhookNotification('https://discord.com/api/webhooks/123/abc', 'Player', entries);
    await flushPromises();
    // 25 entries -> ceil(25/10) = 3 requests
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('processes queue items sequentially', async () => {
    const calls: number[] = [];
    let resolveFn: ((v: unknown) => void) | null = null;

    mockSend = jest.fn().mockImplementation((_body: unknown) => {
      const body = _body as { embeds: unknown[] };
      calls.push((body.embeds ?? []).length);
      if (!resolveFn) {
        return new Promise((resolve) => {
          resolveFn = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    // Re-wire the mock into the already-required discord.js module
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const djs = require('discord.js') as { WebhookClient: jest.Mock };
    djs.WebhookClient.mockImplementation(() => ({ send: mockSend }));

    const e1 = [makeEntry({ sessionId: 'q1', createdTimestamp: 1 })];
    const e2 = [makeEntry({ sessionId: 'q2', createdTimestamp: 2 })];

    enqueueWebhookNotification('https://discord.com/api/webhooks/123/abc', 'Player1', e1);
    enqueueWebhookNotification('https://discord.com/api/webhooks/123/abc', 'Player2', e2);

    await flushPromises();
    // First item should be in-flight (pending), second queued
    expect(calls).toHaveLength(1);

    // Resolve the first item
    resolveFn!(undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('upsertArchivedSessionNotification', () => {
  it('does nothing and resolves undefined when webhookUrl is empty', async () => {
    const result = await upsertArchivedSessionNotification('', 'Player', makeEntry());
    expect(result).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockEditMessage).not.toHaveBeenCalled();
  });

  it('posts a new message and returns its id when no existingMessageId is given', async () => {
    const result = await upsertArchivedSessionNotification(
      'https://discord.com/api/webhooks/123/abc',
      'Player',
      makeEntry(),
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockEditMessage).not.toHaveBeenCalled();
    expect(result).toBe('new-msg-id');
  });

  it('edits the existing message in place and returns its id when existingMessageId is given', async () => {
    const result = await upsertArchivedSessionNotification(
      'https://discord.com/api/webhooks/123/abc',
      'Player',
      makeEntry(),
      'old-msg-id',
    );
    expect(mockEditMessage).toHaveBeenCalledTimes(1);
    expect(mockEditMessage.mock.calls[0][0]).toBe('old-msg-id');
    expect(mockSend).not.toHaveBeenCalled();
    expect(result).toBe('edited-msg-id');
  });

  it('falls back to posting a new message if editing fails (e.g. message was deleted)', async () => {
    mockEditMessage.mockRejectedValueOnce(new Error('Unknown Message'));

    const result = await upsertArchivedSessionNotification(
      'https://discord.com/api/webhooks/123/abc',
      'Player',
      makeEntry(),
      'stale-msg-id',
    );
    expect(mockEditMessage).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result).toBe('new-msg-id');
  });

  it('resolves undefined if the send ultimately fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('network error'));

    const result = await upsertArchivedSessionNotification(
      'https://discord.com/api/webhooks/123/abc',
      'Player',
      makeEntry(),
    );
    expect(result).toBeUndefined();
  });
});
