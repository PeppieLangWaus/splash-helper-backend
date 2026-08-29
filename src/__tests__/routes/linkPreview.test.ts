const fetchMock = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).fetch = fetchMock;

import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearCollections } from '../testDb';
import { createTestApp } from '../testApp';

const app = createTestApp();

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearCollections();
  fetchMock.mockReset();
});

describe('GET /api/link-preview', () => {
  it('400s when url is missing', async () => {
    const res = await request(app).get('/api/link-preview');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'url query parameter is required' });
  });

  it('returns unsupported for a non-allowlisted domain, without calling fetch', async () => {
    const res = await request(app).get('/api/link-preview').query({ url: 'https://example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: 'unsupported' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves a wiki article', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        query: {
          pages: {
            '1': {
              title: 'Plague City',
              extract: 'Plague City is a quest.',
              fullurl: 'https://oldschool.runescape.wiki/w/Plague_City',
            },
          },
        },
      }),
    );

    const res = await request(app)
      .get('/api/link-preview')
      .query({ url: 'https://oldschool.runescape.wiki/w/Plague_City' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: 'wiki',
      found: true,
      data: {
        title: 'Plague City',
        extract: 'Plague City is a quest.',
        canonicalUrl: 'https://oldschool.runescape.wiki/w/Plague_City',
      },
    });
  });
});
