import { MongoMemoryServer } from 'mongodb-memory-server';

module.exports = async function globalTeardown() {
  const mongod = (global as Record<string, unknown>).__MONGOD__ as MongoMemoryServer | undefined;
  if (mongod) {
    await mongod.stop();
  }
};
