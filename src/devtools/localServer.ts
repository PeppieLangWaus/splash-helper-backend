import fs from 'fs';
import path from 'path';
import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Local development entrypoint (npm run dev:local).
 *
 * Boots an isolated MongoDB instead of using MONGODB_URI from .env, which
 * points at the production Atlas cluster. This lets you develop and test
 * (including fake active sessions via /dev routes) without writing to
 * production data.
 *
 * Data is written to disk under .devdata/mongo (gitignored) instead of a
 * throwaway temp dir, so it survives restarts (including ts-node-dev
 * respawns) — no more re-seeding a dev admin on every reload. To wipe it,
 * either delete .devdata/mongo or call POST /dev/reset while the server is
 * running (see src/routes/dev.ts), which the frontend dev view can wire a
 * button to.
 *
 * Discord webhooks are NOT overridden here — DISCORD_ACTIVE_WEBHOOK_URL /
 * DISCORD_ARCHIVED_WEBHOOK_URL come straight from .env, same as `npm run
 * dev`. If those point at a real Discord channel, local sessions (including
 * fake ones seeded via /dev routes) will post there.
 *
 * This env var is set before app.ts loads dotenv, and dotenv does not
 * override already-set variables — so this value wins over .env.
 */
const DB_PATH = path.resolve(__dirname, '../../.devdata/mongo');

async function main(): Promise<void> {
  // MongoMemoryServer expects an existing directory when a fixed dbPath is
  // given — it only auto-creates its default throwaway tmpDir, not ours.
  fs.mkdirSync(DB_PATH, { recursive: true });

  const mongod = await MongoMemoryServer.create({
    instance: { dbPath: DB_PATH, storageEngine: 'wiredTiger' },
  });
  process.env.MONGODB_URI = mongod.getUri();
  if (!process.env.CORS_ORIGIN_API) {
    process.env.CORS_ORIGIN_API = 'http://localhost:5173';
  }

  console.log(`[dev:local] Persistent MongoDB at ${mongod.getUri()} (data: ${DB_PATH})`);

  await import('../app');
}

main().catch((err) => {
  console.error('Failed to start local dev server:', err);
  process.exit(1);
});
