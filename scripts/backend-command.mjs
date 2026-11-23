import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [command, ...args] = process.argv.slice(2);
if (!['start:dev', 'db:inspect', 'db:provision', 'db:migrate', 'seed:demo'].includes(command)) {
  throw new Error('Unknown backend command.');
}
const directory = fileURLToPath(new URL('../backend/', import.meta.url));
const environment = fileURLToPath(new URL('../backend/.env', import.meta.url));
if (existsSync(environment)) process.loadEnvFile(environment);
else throw new Error('Run npm run setup:env before using local backend commands.');
if (command === 'start:dev') {
  process.env.NODE_ENV ??= 'development';
  if (!['development', 'test'].includes(process.env.NODE_ENV)) {
    throw new Error('api:dev does not launch production configurations.');
  }
  process.env.ALLOW_INSECURE_LOCAL_HTTP ??= 'true';
}
const result = spawnSync('npm', ['run', command, ...(args.length ? ['--', ...args] : [])], {
  cwd: directory,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw new Error('Could not launch npm for the backend command.');
process.exit(result.status ?? 1);
