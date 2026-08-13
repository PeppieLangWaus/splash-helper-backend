const fetchMock = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).fetch = fetchMock;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
  };
}

/** Re-imports the module fresh so env-var-driven constants (rate limits, token) are re-read for
 *  each test — same reasoning as chatRelay.test.ts's `require` for its own env-driven config. */
function loadModule() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../services/itemLogResolver') as typeof import('../../services/itemLogResolver');
}

beforeEach(() => {
  jest.resetModules();
  fetchMock.mockReset();
  process.env.RUNEPROFILE_RATE_LIMIT_MAX = '2';
  process.env.RUNEPROFILE_RATE_LIMIT_WINDOW_MS = '100000';
  process.env.RUNELITE_RATE_LIMIT_MAX = '2';
  process.env.RUNELITE_RATE_LIMIT_WINDOW_MS = '100000';
  delete process.env.RUNEPROFILE_API_TOKEN;
});

const logPage = { kind: 'collection-log' as const, page: 'cyclopes', missingOnly: false };

describe('resolveItemLogCommand — outbound rate limiting', () => {
  it('allows requests up to the configured max, then skips without calling fetch', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValue(jsonResponse(200, { name: 'Cyclopes', items: [{ id: 8844, quantity: 1 }] }));

    const first = await resolveItemLogCommand('Zezima', logPage);
    const second = await resolveItemLogCommand('Zezima', logPage);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first).toEqual([{ id: 8844, quantity: 1 }]);
    expect(second).toEqual([{ id: 8844, quantity: 1 }]);

    const third = await resolveItemLogCommand('Zezima', logPage);
    expect(fetchMock).toHaveBeenCalledTimes(2); // no new call made — skipped by the self-throttle
    expect(third).toBeNull();
  });

  it('tracks the RuneProfile and RuneLite limits independently', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValue(jsonResponse(200, { name: 'Cyclopes', items: [] }));
    await resolveItemLogCommand('Zezima', logPage);
    await resolveItemLogCommand('Zezima', logPage); // RuneProfile limiter now exhausted (max 2)

    fetchMock.mockResolvedValueOnce(jsonResponse(200, [12898]));
    const pets = await resolveItemLogCommand('Zezima', { kind: 'pets' });
    expect(pets).toEqual([{ id: 12898, quantity: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('backs off after an upstream 429, honoring Retry-After, independent of remaining window budget', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValueOnce(jsonResponse(429, {}, { 'Retry-After': '60' }));

    const first = await resolveItemLogCommand('Zezima', logPage);
    expect(first).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Still within the 60s 429 backoff, and well within the sliding window's own remaining
    // budget (max 2, only 1 used) — this second call is skipped by the backoff specifically.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: 'Cyclopes', items: [] }));
    const second = await resolveItemLogCommand('Zezima', logPage);
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a default backoff when Retry-After is absent', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValueOnce(jsonResponse(429, {}));

    await resolveItemLogCommand('Zezima', logPage);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: 'Cyclopes', items: [] }));
    const second = await resolveItemLogCommand('Zezima', logPage);
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('resolveItemLogCommand — API token', () => {
  it('sends an Authorization header for RuneProfile once configured, never for RuneLite', async () => {
    process.env.RUNEPROFILE_API_TOKEN = 'test-token';
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValue(jsonResponse(200, { name: 'Cyclopes', items: [] }));

    await resolveItemLogCommand('Zezima', logPage);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');

    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    await resolveItemLogCommand('Zezima', { kind: 'pets' });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });

  it('omits the Authorization header entirely when no token is configured', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValue(jsonResponse(200, { name: 'Cyclopes', items: [] }));

    await resolveItemLogCommand('Zezima', logPage);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
