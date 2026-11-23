const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const bmp = require('bmp-ts');
const { readConfig } = require('../src/common/config');
const { decodeBase64 } = require('../src/common/base64.util');
const { validateRasterImage } = require('../src/common/image.util');
const { canonicalDmKey, cleanContent, cleanName, cleanFileName, normalizeObjectId } = require('../src/common/input.util');
const { FileService } = require('../src/file/file.service');

const A = '64b8f9e2c4a3b12d4e5f6789';
const B = '64b8f9e2c4a3b12d4e5f6790';
const FILE_ID = '64b8f9e2c4a3b12d4e5f9001';
const validPng = () => sharp({ create: { width: 2, height: 2, channels: 4, background: '#4682b4' } }).png().toBuffer();

test('ObjectIds are canonical before pair deduplication', () => {
  assert.equal(normalizeObjectId(A.toUpperCase()), A);
  assert.equal(canonicalDmKey([B.toUpperCase(), A, A.toUpperCase()]), `dm:${A}:${B}`);
  assert.throws(() => canonicalDmKey([A, A.toUpperCase()]));
  assert.throws(() => normalizeObjectId('not-an-id'));
});

test('content, names and filenames reject unsafe or excessive input', () => {
  assert.equal(cleanContent(''), null);
  assert.equal(cleanContent('   '), null);
  assert.equal(cleanContent('a\ncaption'), 'a\ncaption');
  for (const content of ['x'.repeat(4001), 'hello\u001b[31m', 'hello\u0000', '\ud800']) assert.throws(() => cleanContent(content));
  for (const name of [' ', 'x'.repeat(101), 'name\u001b[31m', '\ud800']) assert.throws(() => cleanName(name));
  for (const name of [' ', '../file.png', 'folder\\file.jpg', 'file\n.png', '.']) assert.throws(() => cleanFileName(name));
  assert.equal(cleanFileName(' photo.png '), 'photo.png');
});

test('configuration bounds reject negative, infinite and huge environment values', () => {
  for (const env of [{ MAX_UPLOAD_MB: '-1' }, { MAX_UPLOAD_MB: 'Infinity' }, { MAX_UPLOAD_MB: '13' },
    { MAX_INLINE_IMAGE_MB: '5' }, { REMOTE_FETCH_TIMEOUT_MS: '999999' }, { MAX_CONCURRENT_UPLOADS: '0' },
    { MAX_CONCURRENT_MEDIA_READS: '999' }, { BOT_MODE: 'yes' }, { CORS_ORIGINS: '*' },
    { NODE_ENV: 'production', ALLOW_INSECURE_LOCAL_HTTP: 'true' }]) assert.throws(() => readConfig(env));
  const config = readConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'https://chat.example.test' });
  assert.equal(config.allowLocalHttp, false);
  assert.equal(config.botMode, false);
});

test('base64 decoding validates padding, character set and decoded size', () => {
  assert.equal(decodeBase64(' Zg==\n').buffer.toString(), 'f');
  assert.equal(decodeBase64('data:image/png;base64,Zg==').mimeType, 'image/png');
  for (const input of ['', ' ', 'not base64!', 'Zh==', 'Zg=', 'Zg===', 'data:image/png,abc', 'data:text/plain;base64,%%%%']) {
    assert.throws(() => decodeBase64(input));
  }
  assert.throws(() => decodeBase64('AAAA', 1), (error) => error.getStatus() === 413);
  assert.throws(() => decodeBase64('AAAA'.repeat(1000), 10), (error) => error.getStatus() === 413);
});

test('raster validation decodes valid pixels and rejects signature-only/truncated images', async () => {
  const png = await validPng();
  assert.equal(await validateRasterImage(png), 'image/png');
  for (const image of [Buffer.from('iVBORw0KGgo=', 'base64'), png.subarray(0, Math.floor(png.length / 2)), Buffer.from([0xff, 0xd8, 0xff])]) {
    await assert.rejects(validateRasterImage(image), (error) => error.getStatus() === 400);
  }
  assert.equal(await validateRasterImage(Buffer.from('<svg><script>bad()</script></svg>')), null);
  const wide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(validateRasterImage(wide), (error) => error.getStatus() === 413);
});

test('uploads sniff decoded raster MIME and never store blank filenames', async () => {
  let data;
  const service = new FileService({ file: { create: async (input) => {
    data = input.data;
    return { ...data, id: FILE_ID, createdAt: new Date(), sourceUrl: null };
  } } });
  const png = await validPng();
  const uploaded = await service.upload({ data: png.toString('base64'), file_name: 'photo.jpg', mime_type: 'image/jpeg' }, A);
  assert.equal(uploaded.kind, 'IMAGE');
  assert.equal(uploaded.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(data.data), png);
  await assert.rejects(service.upload({ data: png.toString('base64'), file_name: '  ' }, A));
  await assert.rejects(service.upload({ data: 'iVBORw0KGgo=', file_name: 'broken.png' }, A));
});

test('valid legacy BMP pixels decode while huge palettes, malformed headers and truncation fail', async () => {
  const image = bmp.encode({ width: 2, height: 2, data: Buffer.alloc(16, 128) }).data;
  assert.equal(await validateRasterImage(image), 'image/bmp');
  await assert.rejects(validateRasterImage(image.subarray(0, image.length - 2)));
  const palette = Buffer.from(image);
  palette.writeUInt32LE(0xffffffff, 46);
  await assert.rejects(validateRasterImage(palette), (error) => error.getStatus() === 400);
  const bomb = Buffer.from(image);
  bomb.writeInt32LE(8193, 18);
  await assert.rejects(validateRasterImage(bomb), (error) => error.getStatus() === 413);
});

test('outsider file reads authorize before loading binary data', async () => {
  const selections = [];
  const service = new FileService({
    file: { findUnique: async (input) => { selections.push(input.select); return { id: FILE_ID, uploadedBy: A }; } },
    conversation: { findMany: async () => [] },
  });
  await assert.rejects(service.getForDownload(FILE_ID.toUpperCase(), B), (error) => error.getStatus() === 403);
  assert.deepEqual(selections, [{ id: true, uploadedBy: true }]);
});
