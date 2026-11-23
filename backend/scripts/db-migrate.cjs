const { analyzeDatabase, loadDatabaseSnapshot, migrateDatabase, DatabaseSafetyError } = require('../src/prisma/database');
const { run } = require('./db-common.cjs');

void run(async (prisma) => {
  let apply = false;
  let reviewToken;
  const approvedBots = [];
  for (const argument of process.argv.slice(2)) {
    if (argument === '--apply') apply = true;
    else if (/^--review-token=[0-9a-f]{64}$/.test(argument)) reviewToken = argument.slice(15);
    else if (/^--approve-bot-id=[0-9a-f]{24}$/i.test(argument)) approvedBots.push(argument.slice(17).toLowerCase());
    else throw new DatabaseSafetyError('Unknown migration argument. Use --apply, --review-token=<dry-run token>, or --approve-bot-id=<reviewed reserved user ID>');
  }
  let credentialResets = {};
  if (process.env.MIGRATION_CREDENTIALS_JSON) {
    try { credentialResets = JSON.parse(process.env.MIGRATION_CREDENTIALS_JSON); } catch {
      throw new DatabaseSafetyError('MIGRATION_CREDENTIALS_JSON must be an object keyed by legacy user IDs');
    }
    if (!credentialResets || Array.isArray(credentialResets) || typeof credentialResets !== 'object' ||
        Object.entries(credentialResets).some(([id, value]) => !/^[0-9a-f]{24}$/.test(id) || typeof value !== 'string')) {
      throw new DatabaseSafetyError('MIGRATION_CREDENTIALS_JSON must be an object keyed by canonical legacy user IDs');
    }
  }
  if (!apply) return {
    mode: 'dry-run', ...analyzeDatabase(await loadDatabaseSnapshot(prisma), approvedBots),
    approvedBotIds: approvedBots, credentialResetIds: Object.keys(credentialResets),
    steps: ['Back up the database and stop all API writers', 'Resolve conflicts without deleting or merging histories/accounts',
      'Review credential and bot identity decisions', 'Apply with the exact review token and MIGRATION_ACKNOWLEDGE_BACKUP=true',
      'Run db:provision before restarting the API'],
  };
  return migrateDatabase(prisma, {
    reviewToken, acknowledgedBackup: process.env.MIGRATION_ACKNOWLEDGE_BACKUP === 'true', credentialResets, approvedBots,
  });
});
