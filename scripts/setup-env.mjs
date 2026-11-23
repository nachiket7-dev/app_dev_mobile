import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../backend/.env', import.meta.url));
const password = randomBytes(24).toString('hex');
const database = `mongodb://chatadmin:${password}@127.0.0.1:27027/test_demo?authSource=admin&replicaSet=rs0&directConnection=true`;
const content = [
  '# Generated local, disposable demo configuration. Never deploy this file.',
  'MONGO_USERNAME=chatadmin',
  `MONGO_PASSWORD=${password}`,
  'MONGO_DATABASE=test_demo',
  'MONGO_PORT=27027',
  'API_PORT=3000',
  'API_BIND_HOST=127.0.0.1',
  `DATABASE_URL="${database}"`,
  `TEST_DATABASE_URL="${database}"`,
  'PORT=3000',
  'BIND_HOST=127.0.0.1',
  'NODE_ENV=development',
  'ALLOW_INSECURE_LOCAL_HTTP=true',
  'TRUST_PROXY_HOPS=0',
  'CORS_ORIGINS=http://localhost:8081,http://127.0.0.1:8081,http://localhost:4173,http://127.0.0.1:4173',
  'MONGO_SILENT_LOGS=true',
  'MAX_UPLOAD_MB=10',
  'MAX_INLINE_IMAGE_MB=2',
  'MAX_IMAGE_PIXELS=16000000',
  'BOT_MODE=false',
  '',
].join('\n');

try {
  await writeFile(target, content, { flag: 'wx', mode: 0o600 });
  console.log('Created owner-only backend/.env for a disposable local demo. Database credentials were not printed.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Kept existing backend/.env unchanged. Review its database, ports and local HTTP settings before starting services.');
}
