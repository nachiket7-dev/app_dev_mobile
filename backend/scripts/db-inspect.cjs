const { inspectDatabase } = require('../src/prisma/database');
const { noArguments, run } = require('./db-common.cjs');

void run(async (prisma) => {
  noArguments();
  return inspectDatabase(prisma);
});
