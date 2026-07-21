import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Local development entrypoint (npm run dev:local).
 *
 * Boots an isolated in-memory MongoDB instead of using MONGODB_URI from
 * .env, which points at the production Atlas cluster. This lets you develop
 * and test (including fake active sessions via /dev routes) without writing
 * to production data.
 *
 * Discord webhooks are NOT overridden here — DISCORD_ACTIVE_WEBHOOK_URL /
 * DISCORD_ARCHIVED_WEBHOOK_URL come straight from .env, same as `npm run
 * dev`. If those point at a real Discord channel, local sessions (including
 * fake ones seeded via /dev routes) will post there.
 *
 * This env var is set before app.ts loads dotenv, and dotenv does not
 * override already-set variables — so this value wins over .env.
 */
async function main(): Promise<void> {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  if (!process.env.CORS_ORIGIN_API) {
    process.env.CORS_ORIGIN_API = 'http://localhost:5173';
  }

  console.log(`[dev:local] In-memory MongoDB at ${mongod.getUri()}`);

  await import('../app');
}

main().catch((err) => {
  console.error('Failed to start local dev server:', err);
  process.exit(1);
});
