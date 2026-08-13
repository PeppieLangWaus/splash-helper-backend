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
  delete process.env.RUNEPROFILE_API_TOKEN;
});

const logPage = { kind: 'collection-log' as const, page: 'cyclopes', missingOnly: false };
const clogBody = { name: 'Cyclopes', items: [{ id: 8844, quantity: 1 }, { id: 8845, quantity: 0 }] };

describe('resolveItemLogCommand — collection log', () => {
  it('includes every item on the page (obtained and not), with a clean summary', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValue(jsonResponse(200, clogBody));

    const result = await resolveItemLogCommand('Zezima', logPage);
    expect(result).toEqual({
      summary: 'Cyclopes (1/2):',
      items: [{ id: 8844, quantity: 1 }, { id: 8845, quantity: 0 }],
      showQuantities: true,
    });
  });

  it('"missing" view keeps only the not-yet-obtained items', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValue(jsonResponse(200, clogBody));

    const result = await resolveItemLogCommand('Zezima', { ...logPage, missingOnly: true });
    expect(result).toEqual({
      summary: 'Cyclopes - missing (1/2):',
      items: [{ id: 8845, quantity: 0 }],
      showQuantities: true,
    });
  });

  it('returns null on a failed lookup (e.g. unlinked account)', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValue(jsonResponse(404, { code: 'AccountNotFound' }));

    expect(await resolveItemLogCommand('Zezima', logPage)).toBeNull();
  });
});

describe('resolveItemLogCommand — pets', () => {
  it('resolves via the RuneProfile collection-log "pets" page, obtained pets only, never showing quantities', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValue(jsonResponse(200, {
      name: 'All Pets',
      items: [{ id: 12898, quantity: 1 }, { id: 13247, quantity: 0 }],
    }));

    const result = await resolveItemLogCommand('Zezima', { kind: 'pets' });
    expect(result).toEqual({
      summary: 'Pets (1):',
      items: [{ id: 12898, quantity: 1 }],
      showQuantities: false,
    });
    expect(fetchMock.mock.calls[0][0]).toContain('/collection-log/pets');
  });
});

describe('resolveItemLogCommand — sender name handling', () => {
  it('strips a leading <img=N> status tag and normalizes non-breaking spaces before the API call', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValue(jsonResponse(200, clogBody));

    const nbsp = String.fromCharCode(0x00a0);
    await resolveItemLogCommand(`<img=2>Some${nbsp}Name`, logPage);
    expect(fetchMock.mock.calls[0][0]).toContain('/profiles/Some%20Name/');
  });
});

describe('resolveItemLogCommand — outbound rate limiting', () => {
  it('allows requests up to the configured max, then skips without calling fetch', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValue(jsonResponse(200, clogBody));

    await resolveItemLogCommand('Zezima', logPage);
    await resolveItemLogCommand('Zezima', logPage);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const third = await resolveItemLogCommand('Zezima', logPage);
    expect(fetchMock).toHaveBeenCalledTimes(2); // no new call made — skipped by the self-throttle
    expect(third).toBeNull();
  });

  it('shares one limiter across !log and !pets, since both hit RuneProfile', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValue(jsonResponse(200, clogBody));
    await resolveItemLogCommand('Zezima', logPage);
    await resolveItemLogCommand('Zezima', logPage); // limiter now exhausted (max 2)

    const pets = await resolveItemLogCommand('Zezima', { kind: 'pets' });
    expect(pets).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('backs off after an upstream 429, honoring Retry-After, independent of remaining window budget', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValueOnce(jsonResponse(429, {}, { 'Retry-After': '60' }));

    const first = await resolveItemLogCommand('Zezima', logPage);
    expect(first).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Still within the 60s 429 backoff, and well within the sliding window's own remaining
    // budget (max 2, only 1 used) — this second call is skipped by the backoff specifically.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, clogBody));
    const second = await resolveItemLogCommand('Zezima', logPage);
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a default backoff when Retry-After is absent', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValueOnce(jsonResponse(429, {}));

    await resolveItemLogCommand('Zezima', logPage);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, clogBody));
    const second = await resolveItemLogCommand('Zezima', logPage);
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('resolveItemLogCommand — API token', () => {
  it('sends an Authorization header once configured, for both !log and !pets (both hit RuneProfile)', async () => {
    process.env.RUNEPROFILE_API_TOKEN = 'test-token';
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValue(jsonResponse(200, clogBody));

    await resolveItemLogCommand('Zezima', logPage);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: 'All Pets', items: [] }));
    await resolveItemLogCommand('Zezima', { kind: 'pets' });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer test-token');
  });

  it('omits the Authorization header entirely when no token is configured', async () => {
    const { resolveItemLogCommand } = loadModule();
    fetchMock.mockResolvedValue(jsonResponse(200, clogBody));

    await resolveItemLogCommand('Zezima', logPage);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
