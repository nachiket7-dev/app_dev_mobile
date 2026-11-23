const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');
const zlib = require('node:zlib');
const { fetchRemoteFile, isPublicAddress } = require('../src/common/remote-fetch.util');

test('SSRF classification rejects local, private, mapped and reserved addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.18.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1',
    '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fc00::1', '2001:db8::1', '2002:7f00:1::', 'not-an-ip']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('remote streams are bounded and cleaned up, using only explicit loopback fixtures', async (t) => {
  const sockets = new Set();
  const closed = new Map();
  const server = http.createServer((request, response) => {
    const path = request.url;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    closed.set(path, promise);
    response.once('close', resolve);
    if (path === '/ok') {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="fixture.txt"' });
      response.end('fixture');
    } else if (path === '/redirect') {
      response.writeHead(302, { Location: '/ok' }); response.write('unbounded body never ends');
    } else if (path === '/invalid-redirect') {
      response.writeHead(302, { Location: 'http://[broken' }); response.write('never ends');
    } else if (path === '/private-redirect') {
      response.writeHead(302, { Location: 'http://127.0.0.1/private' }); response.write('never ends');
    } else if (path === '/loop') {
      response.writeHead(302, { Location: '/loop' }); response.write('never ends');
    } else if (path === '/error') {
      response.writeHead(500); response.write('unbounded error body never ends');
    } else if (path === '/gzip-bomb') {
      response.writeHead(200, { 'Content-Encoding': 'gzip' }); response.end(zlib.gzipSync(Buffer.alloc(4096, 65)));
    } else if (path === '/bad-gzip') {
      response.writeHead(200, { 'Content-Encoding': 'gzip' }); response.end('bad compressed bytes');
    } else if (path === '/encoding') {
      response.writeHead(200, { 'Content-Encoding': 'unsupported' }); response.write('never ends');
    } else if (path === '/slow-body') {
      response.writeHead(200); response.write('part');
    } else if (path === '/slow-headers') {
      // Intentionally withhold headers; the downloader's deadline must close this socket.
    } else if (path === '/truncated') {
      response.writeHead(200, { 'Content-Length': '40' }); response.end('short');
    } else response.end('unexpected route');
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  t.mock.method(dns, 'lookup', (hostname, options, callback) => {
    if (hostname !== 'fixture.invalid') return queueMicrotask(() => callback(Object.assign(new Error('fixture-only DNS'), { code: 'ENOTFOUND' })));
    queueMicrotask(() => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4));
  });
  const base = `http://fixture.invalid:${server.address().port}`;
  const options = { maxBytes: 100, timeoutMs: 1000, isAllowedAddress: (ip) => ip === '127.0.0.1' };
  const waitForClose = async (path) => {
    let timer;
    try { await Promise.race([closed.get(path), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture stream did not close')), 1500); })]); }
    finally { clearTimeout(timer); }
  };
  await t.test('production policy blocks fixture DNS unless the test explicitly overrides it', async () => {
    await assert.rejects(fetchRemoteFile(`${base}/ok`, { maxBytes: 100, timeoutMs: 1000 }), (error) => error.getStatus() === 400);
    await assert.rejects(fetchRemoteFile('http://127.0.0.1/private', options), (error) => error.getStatus() === 400);
  });
  await t.test('relative redirects close their bodies and preserve the final file', async () => {
    const result = await fetchRemoteFile(`${base}/redirect`, options);
    assert.equal(result.buffer.toString(), 'fixture');
    assert.equal(result.fileName, 'fixture.txt');
    assert.equal(result.finalUrl, `${base}/ok`);
    await waitForClose('/redirect');
  });
  for (const path of ['/invalid-redirect', '/private-redirect', '/error', '/encoding', '/loop']) {
    await t.test(`${path} rejects with a controlled error and destroys the stream`, async () => {
      await assert.rejects(fetchRemoteFile(`${base}${path}`, options), (error) => error.getStatus() === 400);
      await waitForClose(path);
    });
  }
  await t.test('decompression has decoded bounds and controlled invalid-data errors', async () => {
    await assert.rejects(fetchRemoteFile(`${base}/gzip-bomb`, options), (error) => error.getStatus() === 413);
    await assert.rejects(fetchRemoteFile(`${base}/bad-gzip`, options), (error) => error.getStatus() === 400);
  });
  for (const path of ['/slow-body', '/slow-headers', '/truncated']) {
    await t.test(`${path} closes within a total deadline`, async () => {
      await assert.rejects(fetchRemoteFile(`${base}${path}`, { ...options, timeoutMs: 100 }), (error) => error.getStatus() === 400);
      await waitForClose(path);
    });
  }
});
