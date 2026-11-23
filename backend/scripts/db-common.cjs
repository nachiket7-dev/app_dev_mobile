const { PrismaClient } = require('@prisma/client');
const { DatabaseSafetyError } = require('../src/prisma/database');

function databaseUrl(name = 'DATABASE_URL', testOnly = false) {
  const value = process.env[name];
  if (!value) throw new DatabaseSafetyError(`${name} must be explicitly supplied; scripts do not load .env`);
  let url;
  try { url = new URL(value); } catch { throw new DatabaseSafetyError(`${name} is invalid`); }
  if (!['mongodb:', 'mongodb+srv:'].includes(url.protocol) || !url.pathname || url.pathname === '/') {
    throw new DatabaseSafetyError(`${name} must name a MongoDB database`);
  }
  if (testOnly) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '::1'].includes(host) ||
        !/^\/test_[a-z0-9_-]+$/i.test(url.pathname) || !url.port || url.port === '27017' || !url.searchParams.get('replicaSet')) {
      throw new DatabaseSafetyError('TEST_DATABASE_URL must target an isolated loopback replica set on a non-default port and a test_* database');
    }
  }
  return value;
}

async function run(operation, name = 'DATABASE_URL', testOnly = false) {
  let prisma;
  try {
    prisma = new PrismaClient({ datasourceUrl: databaseUrl(name, testOnly), log: [] });
    const result = await operation(prisma);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof DatabaseSafetyError ? error.message : 'Database operation failed; check connectivity, replica set, installed Prisma client and reviewed inputs. Sensitive details suppressed.');
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {
      console.error('Database client cleanup failed; sensitive details suppressed.');
      process.exitCode = 1;
    });
  }
}

function noArguments() {
  if (process.argv.length > 2) throw new DatabaseSafetyError('Unexpected script arguments');
}

module.exports = { databaseUrl, run, noArguments };
