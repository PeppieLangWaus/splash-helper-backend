import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod: MongoMemoryServer;

module.exports = async function globalSetup() {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.SETUP_LINK_SECRET = 'test-setup-secret';
  process.env.ADMIN_SECRET = 'test-admin-secret';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  process.env.DISCORD_ARCHIVED_WEBHOOK_URL = '';
  process.env.DISCORD_BOT_TOKEN = '';
  (global as Record<string, unknown>).__MONGOD__ = mongod;
};
