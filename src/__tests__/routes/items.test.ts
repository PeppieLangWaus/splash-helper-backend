import request from 'supertest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { createTestApp } from '../testApp';

const app = createTestApp();

// data/item-icons/ is populated by `npm run render-item-icons` (scripts/render-item-icons.ts) and
// gitignored (it's a ~4000-file generated set, regenerated per cache version, not something to
// commit) — so this test writes its own throwaway fixture rather than depending on a real
// pre-rendered icon being present on disk.
const ICONS_DIR = path.join(__dirname, '..', '..', '..', 'data', 'item-icons');
const TEST_ID = 900000001; // well outside any real OSRS item id range
const TEST_ICON_PATH = path.join(ICONS_DIR, `${TEST_ID}.png`);
// Smallest possible valid PNG (1x1, transparent) — the route only cares that a file exists and
// starts with the PNG magic bytes, not what it actually depicts.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

beforeAll(() => {
  mkdirSync(ICONS_DIR, { recursive: true });
  writeFileSync(TEST_ICON_PATH, PNG_1X1);
});

afterAll(() => {
  rmSync(TEST_ICON_PATH, { force: true });
});

describe('GET /api/items/:id/icon', () => {
  it('serves a rendered icon for a known item id', async () => {
    const res = await request(app).get(`/api/items/${TEST_ID}/icon`);
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
