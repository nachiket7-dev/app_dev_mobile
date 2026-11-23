import { spawnSync } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set(['node_modules', '.git', '.expo', '.artifacts', '.kilo', 'dist', 'coverage', 'test-results', 'playwright-report', 'backups', 'backup', 'dump', 'ios', 'android']);
const rootDirectories = new Set(['src', 'assets', 'backend', 'scripts', 'tests', 'e2e', '.github']);
const rootFiles = new Set(['package.json', 'package-lock.json', 'app.json', 'eas.json', 'tsconfig.json', 'eslint.config.js', 'playwright.config.ts', 'App.js', 'index.js', '.gitignore', '.nvmrc', '.env.example', 'README.md', 'README_API.md', 'SUBMISSION_PLAN.md', 'PROJECT_AUDIT.md', 'AGENTS.md', 'CLAUDE.md']);
const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory === root && !(entry.isDirectory() ? rootDirectories : rootFiles).has(entry.name)) continue;
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.env') && entry.name !== '.env.example') continue;
    if (/\.(pem|key|p8|p12|jks|keystore|mobileprovision|dump|archive|bson|apk|aab|ipa|tsbuildinfo)(\.gz)?$/.test(entry.name) || entry.name === '.DS_Store') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) files.push(relative(root, path));
  }
}
await collect(root);
await mkdir(resolve(root, '.artifacts'), { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const archive = resolve(root, '.artifacts', `campus-chat-source-${timestamp}.zip`);
const result = spawnSync('zip', ['-q', archive, ...files], { cwd: root, stdio: 'inherit' });
if (result.error || result.status !== 0) {
  throw new Error('Source packaging requires the zip utility. Package the listed source only, never local environment/data/signing files.');
}
console.log(`Created source archive with ${files.length} files: ${archive}`);
console.log('Excluded dependencies, caches, environment secrets, database backups, signing files and generated native builds.');
