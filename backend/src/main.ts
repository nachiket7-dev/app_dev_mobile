import { Logger } from '@nestjs/common';
import { createApplication } from './bootstrap';
import { CONFIG } from './common/config';

async function bootstrap() {
  const app = await createApplication();
  try { await app.listen(CONFIG.port, CONFIG.bindHost); } catch (error) {
    await app.close();
    throw error;
  }
  new Logger('Bootstrap').log(`Backend ready on port ${CONFIG.port}; public readiness at /health`);
}

void bootstrap().catch(() => {
  new Logger('Bootstrap').error('Startup failed; verify configuration, replica set and npm run db:provision. Sensitive details suppressed.');
  process.exitCode = 1;
});
