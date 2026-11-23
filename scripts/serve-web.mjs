import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, sep, extname } from 'node:path';

const options = process.argv.slice(2);
if (options.some((value, index) => index % 2 === 0 && !['--dir', '--port'].includes(value)) || options.length % 2) {
  throw new Error('Usage: npm run serve:web -- [--dir dist/web] [--port 4173]');
}
const parameters = Object.fromEntries(Array.from({ length: options.length / 2 }, (_, index) => [options[index * 2], options[index * 2 + 1]]));
const directory = resolve(parameters['--dir'] || 'dist/web');
const port = Number(parameters['--port'] || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local preview port.');
const entry = resolve(directory, 'index.html');
if (!existsSync(entry)) throw new Error('Export the web application first with npm run export:web.');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  let file;
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    file = resolve(directory, `.${path}`);
    if (file !== directory && !file.startsWith(`${directory}${sep}`)) throw new Error('Invalid path');
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (request.headers.accept?.includes('text/html')) file = entry;
      else { response.writeHead(404); response.end(); return; }
    }
  } catch { response.writeHead(400); response.end(); return; }
  response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (request.method === 'HEAD') { response.end(); return; }
  const stream = createReadStream(file);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`Local production preview: http://127.0.0.1:${port}`));
