const { provisionDatabase } = require('../src/prisma/database');
const { noArguments, run } = require('./db-common.cjs');

void run(async (prisma) => {
  noArguments();
  return provisionDatabase(prisma);
});
