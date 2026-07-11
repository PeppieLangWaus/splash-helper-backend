import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Local development entrypoint (npm run dev:local).
 *
 * Boots an isolated in-memory MongoDB instead of using MONGODB_URI from
 * .env, which points at the production Atlas cluster. This lets you develop
 * and test (including fake active sessions via /dev routes) without writing
 * to production data or firing real Discord webhooks.
 *
 * These env vars are set before app.ts loads dotenv, and dotenv does not
 * override already-set variables — so these values win over .env.
 */
async function main(): Promise<void> {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.DISCORD_ACTIVE_WEBHOOK_URL = '';
  process.env.DISCORD_ARCHIVED_WEBHOOK_URL = '';
  if (!process.env.CORS_ORIGIN_API) {
    process.env.CORS_ORIGIN_API = 'http://localhost:5173';
  }

  console.log(`[dev:local] In-memory MongoDB at ${mongod.getUri()}`);
  console.log('[dev:local] Discord webhooks disabled');

  await import('../app');
}

main().catch((err) => {
  console.error('Failed to start local dev server:', err);
  process.exit(1);
});
