import request from 'supertest';
import { createTestApp } from '../testApp';

const app = createTestApp();

describe('GET /api/items/:id/icon', () => {
  it('serves a rendered icon for a known item id', async () => {
    // 995 = Coins — checked into data/item-icons/ as one of a handful of fixture icons rendered
    // for testing; the full set is populated by `npm run render-item-icons` (see
    // scripts/render-item-icons.ts), not committed wholesale for every OSRS item.
    const res = await request(app).get('/api/items/995/icon');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.body.slice(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); // PNG magic bytes
  });

  it('404s for a well-formed id with no rendered icon', async () => {
    const res = await request(app).get('/api/items/999999999/icon');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('400s for a non-numeric id', async () => {
    const res = await request(app).get('/api/items/abc/icon');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid item id' });
  });

  it('400s for a negative id', async () => {
    const res = await request(app).get('/api/items/-1/icon');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid item id' });
  });
});
