require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const zlib = require('node:zlib');

if (!process.env.TEST_DATABASE_URL) {
  test('isolated MongoDB HTTP/security/concurrency integration', {
    skip: 'Set explicit TEST_DATABASE_URL to a test_* database on a non-default loopback replica-set port; no development DB fallback',
  }, () => {});
} else {
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_INSECURE_LOCAL_HTTP = 'true';
  process.env.BOT_MODE = 'false';
  process.env.BIND_HOST = '127.0.0.1';
  process.env.CORS_ORIGINS = 'http://localhost:8081,http://127.0.0.1:8081';
  process.env.REQUESTS_PER_MINUTE = '3000';
  process.env.MAX_CONCURRENT_UPLOADS = '16';
  process.env.MAX_CONCURRENT_MEDIA_READS = '8';
  process.env.MAX_UPLOAD_MB = '1';
  process.env.MAX_INLINE_IMAGE_MB = '1';

  const { databaseUrl } = require('../../scripts/db-common.cjs');
  const template = new URL(databaseUrl('TEST_DATABASE_URL', true));
  const { PrismaClient } = require('@prisma/client');
  const { createApplication } = require('../../src/bootstrap');
  const { provisionDatabase, inspectDatabase, migrateDatabase, loadDatabaseSnapshot, analyzeDatabase,
    verifyDatabaseReady, DatabaseSafetyError } = require('../../src/prisma/database');
  const { verifyPassword } = require('../../src/auth/password');
  const sharp = require('sharp');
  const nonce = randomBytes(6).toString('hex');
  const oid = (id) => ({ $oid: id });
  const newId = () => randomBytes(12).toString('hex');
  const date = { $date: '2026-11-01T12:00:00.000Z' };

  test('real included-backend HTTP, security, concurrency and reviewed migration', { timeout: 180_000 }, async (t) => {
    const disposable = [];
    let app;
    const openDatabase = (label) => {
      const url = new URL(template);
      url.pathname = `/test_backend_${label}_${nonce}`;
      const prisma = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
      disposable.push({ prisma, url });
      return { prisma, url };
    };
    t.after(async () => {
      if (app) await app.close();
      for (const { prisma, url } of disposable) {
        // The sole destructive test operation is guarded against both the supplied base and ordinary data.
        assert.equal(url.host, template.host);
        assert.match(url.pathname, new RegExp(`^/test_backend_[a-z_]+_${nonce}$`));
        assert.notEqual(url.pathname, template.pathname);
        try { await prisma.$runCommandRaw({ dropDatabase: 1 }); } finally { await prisma.$disconnect(); }
      }
    });
    const main = openDatabase('http');
    const prisma = main.prisma;
    process.env.DATABASE_URL = main.url.toString();
    try {
      await provisionDatabase(prisma);
      app = await createApplication({ logger: false });
      // Fault injection belongs only to this isolated test app, never to production source.
      app.use((request, response, next) => {
        if (request.method === 'POST' && request.path === '/message' && request.headers['x-test-drop-response'] === 'true') {
          response.end = () => { response.destroy(); return response; };
        }
        next();
      });
      await app.listen(0, '127.0.0.1');
    } catch {
      throw new Error('Isolated integration setup failed; verify MongoDB PRIMARY/auth and backend provisioning. Sensitive details suppressed.');
    }
    const base = await app.getUrl();
    const password = `disposable-${nonce}`;
    const auth = (user) => `Basic ${user.name}:${user.password ?? password}`;
    const request = async (endpoint, { user, method = 'GET', body, headers = {} } = {}) => {
      const response = await fetch(`${base}${endpoint}`, { method, headers: {
        ...(user ? { Authorization: auth(user) } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers,
      }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data, headers: response.headers };
    };
    const account = async (label) => {
      const name = `${label}_${nonce}`;
      const result = await request('/user/profile', { headers: { Authorization: `Basic ${name}:${password}` } });
      assert.equal(result.status, 200);
      return { ...result.data, password };
    };
    const create = async (user, body) => {
      const result = await request('/conversation', { user, method: 'POST', body });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      return result.data;
    };
    const [alice, bob, outsider] = await Promise.all(['alice', 'bob', 'outsider'].map(account));
    let dm;
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#4682b4' } }).png().toBuffer();

    await t.test('public health and real CORS preflight never auto-register users', async () => {
      const count = await prisma.user.count();
      const result = await request('/health', { headers: { Authorization: 'Basic health_only_probe:unused-test-password' } });
      assert.equal(result.status, 200);
      assert.equal(result.data.status, 'ok');
      assert.deepEqual(result.data.capabilities, { idempotency: true, receipts: true, conversationSummary: true });
      assert.equal(await prisma.user.count(), count);
      assert.ok(!JSON.stringify(result.data).includes('mongodb'));
      const preflight = await request('/user/profile', { method: 'OPTIONS', headers: {
        Origin: 'http://localhost:8081', 'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,content-type',
      } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:8081');
      assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/i);
      const forbidden = await request('/user/profile', { method: 'OPTIONS', headers: {
        Origin: 'https://unapproved.example.test', 'Access-Control-Request-Method': 'GET',
      } });
      assert.equal(forbidden.headers.get('access-control-allow-origin'), null);
      assert.equal(await prisma.user.count(), count);
      const schema = await request('/docs-json');
      assert.equal(schema.data.components.securitySchemes['basic-auth'].type, 'apiKey');
      assert.equal(schema.data.components.securitySchemes['basic-auth'].name, 'Authorization');
    });

    await t.test('eight equal first-use credentials succeed once; different credentials cannot win twice', async () => {
      const name = `concurrent_equal_${nonce}`;
      const results = await Promise.all(Array.from({ length: 8 }, () => request('/user/profile', { headers: { Authorization: `Basic ${name}:${password}` } })));
      assert.deepEqual(results.map((result) => result.status), Array(8).fill(200));
      assert.equal(new Set(results.map((result) => result.data.id)).size, 1);
      assert.equal(await prisma.user.count({ where: { name } }), 1);
      const stored = await prisma.user.findUnique({ where: { name } });
      assert.equal(stored.phone, null);
      assert.equal(await verifyPassword(password, stored.passwordHash), true);
      const other = `concurrent_different_${nonce}`;
      const races = await Promise.all(Array.from({ length: 8 }, (_, index) => request('/user/profile', {
        headers: { Authorization: `Basic ${other}:disposable-different-${index}` },
      })));
      assert.equal(races.filter((result) => result.status === 200).length, 1);
      assert.ok(races.filter((result) => result.status !== 200).every((result) => result.status === 401));
      assert.equal(await prisma.user.count({ where: { name: other } }), 1);
    });

    await t.test('wrong/empty credentials, legacy plaintext and reserved bot authentication fail closed', async () => {
      for (const header of [undefined, `Basic ${alice.name}:wrong`, `Basic ${alice.name}:`, 'Basic FactBot:old-public-secret',
        `Basic ${Buffer.from(`${alice.name}:${password}`).toString('base64')}`]) {
        const result = await request('/user/profile', { headers: header ? { Authorization: header } : {} });
        assert.equal(result.status, 401);
      }
      const legacy = await prisma.user.create({ data: { name: `legacy_no_hash_${nonce}`, phone: 'disposable-legacy' } });
      const result = await request('/user/profile', { headers: { Authorization: `Basic ${legacy.name}:disposable-legacy` } });
      assert.equal(result.status, 401);
      await prisma.user.delete({ where: { id: legacy.id } });
      assert.equal(await prisma.user.count({ where: { name: 'FactBot' } }), 0);
    });

    await t.test('canonical DM and group concurrency is transactional, normalized and collision safe', async () => {
      const poisoned = await request('/conversation', { user: outsider, method: 'POST', body: { type: 'DM', participants_ids: [alice.id, bob.id] } });
      assert.equal(poisoned.status, 400);
      const results = await Promise.all(Array.from({ length: 8 }, () => request('/conversation', {
        user: alice, method: 'POST', body: { type: 'DM', participants_ids: [bob.id.toUpperCase(), alice.id.toUpperCase(), bob.id] },
      })));
      assert.deepEqual(results.map((result) => result.status), Array(8).fill(201));
      assert.equal(new Set(results.map((result) => result.data.id)).size, 1);
      dm = results[0].data;
      assert.deepEqual([...dm.participants_ids].sort(), [alice.id, bob.id].sort());
      const legacy = await create(bob, { recipient_id: alice.id.toUpperCase() });
      assert.equal(legacy.id, dm.id);
      const stored = await prisma.conversation.findUnique({ where: { id: dm.id } });
      assert.equal(stored.conversationKey, `dm:${[alice.id, bob.id].sort().join(':')}`);
      for (const id of [alice.id, bob.id]) {
        const user = await prisma.user.findUnique({ where: { id } });
        assert.equal(user.conversationIds.filter((value) => value === dm.id).length, 1);
      }
      const groups = await Promise.all(Array.from({ length: 8 }, () => create(alice, { type: 'GROUP', name: 'Concurrency fixture', participants_ids: [bob.id] })));
      assert.equal(new Set(groups.map((group) => group.id)).size, 8);
      assert.equal((await request(`/conversation/${dm.id}`, { user: outsider })).status, 403);
    });

    await t.test('outsider text/inline/file metadata reads and writes are denied; photos remain protected', async () => {
      const upload = await request('/file', { user: alice, method: 'POST', body: { file_name: 'fixture.png', data: png.toString('base64') } });
      assert.equal(upload.status, 201);
      assert.equal(upload.data.kind, 'IMAGE');
      const sent = await request('/message', { user: alice, method: 'POST', body: { conversation_id: dm.id, file_id: upload.data.id, content: '' } });
      assert.equal(sent.status, 201);
      assert.equal(sent.data.file.data, undefined);
      assert.equal((await request(`/message?conversation_id=${dm.id}`, { user: outsider })).status, 403);
      assert.equal((await request('/message', { user: outsider, method: 'POST', body: { conversation_id: dm.id, content: 'outsider injection' } })).status, 403);
      assert.equal((await request('/message', { user: outsider, method: 'POST', body: { conversation_id: dm.id, imageInfo: 'not base64!' } })).status, 403);
      assert.equal((await request(`/file/${upload.data.id}`, { user: outsider })).status, 403);
      assert.equal((await request(`/file/${upload.data.id}/download`, { user: outsider })).status, 403);
      assert.equal((await request(`/file/${upload.data.id}/download`)).status, 401);
      const download = await fetch(`${base}/file/${upload.data.id}/download`, { headers: { Authorization: auth(bob) } });
      assert.equal(download.status, 200);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
      assert.equal((await request('/message', { user: bob, method: 'POST', body: { conversation_id: dm.id, file_id: upload.data.id } })).status, 403);
    });

    await t.test('invalid/oversized content, names, files and inline images are bounded', async () => {
      for (const body of [{ conversation_id: dm.id, content: ' ' }, { conversation_id: dm.id, content: 'x'.repeat(4001) },
        { conversation_id: dm.id, imageInfo: 'not base64!' }, { conversation_id: dm.id, imageInfo: 'iVBORw0KGgo=' },
        { conversation_id: dm.id, content: 'text\u001b[31m' }]) {
        assert.equal((await request('/message', { user: alice, method: 'POST', body })).status, 400);
      }
      for (const body of [{ file_name: ' ', data: png.toString('base64') }, { file_name: 'bad.png', data: 'iVBORw0KGgo=' },
        { file_name: 'bad\u001b.png', data: png.toString('base64') }]) assert.equal((await request('/file', { user: alice, method: 'POST', body })).status, 400);
      const tooLarge = Buffer.alloc(1024 * 1024 + 100).toString('base64');
      assert.equal((await request('/file', { user: alice, method: 'POST', body: { file_name: 'large.bin', data: tooLarge } })).status, 413);
      assert.equal((await request('/conversation', { user: alice, method: 'POST', body: { type: 'GROUP', participants_ids: [bob.id], name: ' ' } })).status, 400);
      const inline = await request('/message', { user: alice, method: 'POST', body: { conversation_id: dm.id, imageInfo: png.toString('base64') } });
      assert.equal(inline.status, 201);
      assert.match(inline.data.imageInfo, /^data:image\/png;base64,/);
      const compressed = await fetch(`${base}/message`, { method: 'POST', headers: {
        Authorization: auth(alice), 'Content-Type': 'application/json', 'Content-Encoding': 'gzip',
      }, body: zlib.gzipSync(JSON.stringify({ conversation_id: dm.id, content: 'Valid legacy compressed JSON' })) });
      assert.equal(compressed.status, 201);
      await compressed.arrayBuffer();
    });

    await t.test('eight idempotent sends and a lost committed response cannot duplicate messages', async () => {
      const body = { conversation_id: dm.id, content: 'Retry-safe fixture', client_message_id: randomUUID() };
      const results = await Promise.all(Array.from({ length: 8 }, () => request('/message', { user: alice, method: 'POST', body })));
      assert.deepEqual(results.map((result) => result.status), Array(8).fill(201));
      assert.equal(new Set(results.map((result) => result.data.id)).size, 1);
      assert.equal(results[0].data.clientMessageId, body.client_message_id);
      assert.equal(results[0].data.sendKey, undefined);
      assert.equal(await prisma.message.count({ where: { clientMessageId: body.client_message_id } }), 1);
      assert.equal((await request('/message', { user: alice, method: 'POST', body: { ...body, content: 'conflicting reuse' } })).status, 409);
      const lost = { ...body, client_message_id: randomUUID(), content: 'Committed response intentionally lost' };
      await assert.rejects(fetch(`${base}/message`, { method: 'POST', headers: {
        Authorization: auth(alice), 'Content-Type': 'application/json', 'x-test-drop-response': 'true',
      }, body: JSON.stringify(lost) }));
      const committed = await prisma.message.findFirst({ where: { clientMessageId: lost.client_message_id } });
      assert.ok(committed);
      const replay = await request('/message', { user: alice, method: 'POST', body: lost });
      assert.equal(replay.status, 201);
      assert.equal(replay.data.id, committed.id);
      assert.equal(await prisma.message.count({ where: { clientMessageId: lost.client_message_id } }), 1);
      const other = await create(alice, { type: 'GROUP', participants_ids: [bob.id], name: 'Send scope' });
      assert.equal((await request('/message', { user: alice, method: 'POST', body: { ...body, conversation_id: other.id } })).status, 201);
      assert.equal((await request('/message', { user: bob, method: 'POST', body })).status, 201);
    });

    await t.test('100 same-timestamp messages paginate without skips; exact page boundaries have no phantom cursor', async () => {
      const room = await create(alice, { type: 'GROUP', participants_ids: [bob.id], name: 'History fixture' });
      const timestamp = new Date('2026-11-02T12:00:00.000Z');
      const status = { [alice.id]: { delivered: true, read: true }, [bob.id]: { delivered: false, read: false } };
      await prisma.$transaction(async (tx) => {
        await tx.message.createMany({ data: Array.from({ length: 100 }, (_, index) => ({
          content: `history-${index + 1}`, senderId: alice.id, conversationId: room.id, createdAt: timestamp, status,
        })) });
        const last = await tx.message.findFirst({ where: { conversationId: room.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
        await tx.conversation.update({ where: { id: room.id }, data: {
          activityAt: timestamp, lastMessageAt: timestamp, lastMessageId: last.id, lastMessagePreview: last.content,
          unreadCounts: { [alice.id]: 0, [bob.id]: 100 },
        } });
      });
      const expected = await prisma.message.findMany({ where: { conversationId: room.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, sendKey: true } });
      assert.equal(new Set(expected.map((message) => message.sendKey)).size, 100);
      let cursor;
      let pages = 0;
      const collected = [];
      do {
        const page = await request(`/message?conversation_id=${room.id}${cursor ? `&from_message_cursor=${cursor}` : ''}`, { user: bob });
        assert.equal(page.status, 200);
        collected.unshift(...page.data.data.map((message) => message.id));
        cursor = page.data.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      assert.equal(pages, 5);
      assert.deepEqual(collected, expected.map((message) => message.id));
      const before = await prisma.message.findUnique({ where: { id: expected[0].id } });
      assert.deepEqual(before.status[bob.id], { delivered: false, read: false });
      const foreign = await prisma.message.findFirst({ where: { conversationId: dm.id } });
      assert.equal((await request(`/message?conversation_id=${room.id}&from_message_cursor=${foreign.id}`, { user: bob })).status, 400);
      const exact = await create(alice, { type: 'GROUP', name: 'Exact boundary', participants_ids: [bob.id] });
      await prisma.message.createMany({ data: Array.from({ length: 20 }, () => ({ content: 'exact', senderId: alice.id, conversationId: exact.id, status })) });
      assert.equal((await request(`/message?conversation_id=${exact.id}`, { user: bob })).data.nextCursor, null);

      const ack = { conversation_id: room.id, message_ids: collected, status: 'delivered' };
      assert.equal((await request('/message/acknowledge', { user: bob, method: 'POST', body: ack })).status, 200);
      assert.equal((await request(`/conversation/${room.id}`, { user: bob })).data.unreadCount, 100);
      assert.equal((await request('/message/acknowledge', { user: outsider, method: 'POST', body: ack })).status, 403);
      assert.equal((await request('/message/acknowledge', { user: bob, method: 'POST', body: { ...ack, message_ids: [collected[0], foreign.id], status: 'read' } })).status, 400);
      assert.equal((await request('/message/acknowledge', { user: bob, method: 'POST', body: { ...ack, user_id: alice.id } })).status, 400);
      assert.equal((await request('/message/acknowledge', { user: bob, method: 'POST', body: { ...ack, message_ids: Array(101).fill(collected[0]) } })).status, 400);
      const read = { ...ack, status: 'read' };
      const reads = await Promise.all(Array.from({ length: 3 }, () => request('/message/acknowledge', { user: bob, method: 'POST', body: read })));
      assert.deepEqual(reads.map((result) => result.status), Array(3).fill(200), JSON.stringify(reads.map(({ status, data }) => ({ status, data }))));
      assert.equal((await request(`/conversation/${room.id}`, { user: bob })).data.unreadCount, 0);
      const after = await prisma.message.findUnique({ where: { id: collected[0] } });
      assert.deepEqual(after.status[bob.id], { delivered: true, read: true });
      assert.deepEqual(after.status[alice.id], { delivered: true, read: true });
    });

    await t.test('summary previews contain no binary blobs and recent activity sorts sensibly', async () => {
      const first = await create(alice, { type: 'GROUP', participants_ids: [bob.id], name: 'Summary older' });
      const recent = await create(alice, { type: 'GROUP', participants_ids: [bob.id], name: 'Summary recent' });
      const sent = await request('/message', { user: alice, method: 'POST', body: { conversation_id: first.id, imageInfo: png.toString('base64') } });
      assert.equal(sent.status, 201);
      const metadata = await request(`/conversation/${first.id}`, { user: bob });
      assert.equal(metadata.data.lastMessagePreview, '[Image]');
      assert.equal(metadata.data.unreadCount, 1);
      assert.ok(metadata.data.lastMessageAt);
      assert.ok(!JSON.stringify(metadata.data).includes('base64'));
      await request('/message', { user: bob, method: 'POST', body: { conversation_id: recent.id, content: 'Latest fixture' } });
      const list = await request('/conversation', { user: alice });
      assert.ok(list.data.findIndex((room) => room.id === recent.id) < list.data.findIndex((room) => room.id === first.id));
    });

    await t.test('provisioning repeats safely and verifies required unique and compound indexes', async () => {
      const counts = (await inspectDatabase(prisma)).counts;
      await provisionDatabase(prisma);
      await provisionDatabase(prisma);
      await verifyDatabaseReady(prisma);
      assert.deepEqual((await inspectDatabase(prisma)).counts, counts);
    });

    await t.test('reviewed raw legacy migration preserves accounts, groups and message histories', async () => {
      const legacy = openDatabase('legacy').prisma;
      const a = newId(); const b = newId(); const room = newId(); const history = newId();
      await legacy.$runCommandRaw({ insert: 'users', documents: [
        { _id: oid(a), name: `old_alice_${nonce}`, phone: 'disposable-old-a' },
        { _id: oid(b), name: `old_bob_${nonce}`, phone: 'disposable-old-b' },
      ] });
      await legacy.$runCommandRaw({ insert: 'conversations', documents: [
        { _id: oid(room), type: 'DM', userIds: [oid(a), oid(b)], createdBy: oid(a), createdAt: date },
        ...Array.from({ length: 2 }, () => ({ _id: oid(newId()), type: 'GROUP', name: 'Old group', userIds: [oid(a), oid(b)], createdBy: oid(a), createdAt: date })),
      ] });
      await legacy.$runCommandRaw({ insert: 'messages', documents: [{ _id: oid(history), content: 'Preserved old history',
        senderId: oid(a), conversationId: oid(room), createdAt: date,
        status: { [a]: { delivered: true, read: true }, [b]: { delivered: false, read: false } } }] });
      const report = await inspectDatabase(legacy);
      assert.equal(report.counts.users, 2);
      assert.equal(report.legacy.plaintextPasswords, 2);
      assert.ok(!JSON.stringify(report).includes('disposable-old-a'));
      await assert.rejects(provisionDatabase(legacy), DatabaseSafetyError);
      await assert.rejects(migrateDatabase(legacy, { reviewToken: '0'.repeat(64), acknowledgedBackup: true }), DatabaseSafetyError);
      await assert.rejects(migrateDatabase(legacy, { reviewToken: report.reviewToken, acknowledgedBackup: false }), DatabaseSafetyError);
      await migrateDatabase(legacy, { reviewToken: report.reviewToken, acknowledgedBackup: true });
      await provisionDatabase(legacy);
      const users = await legacy.user.findMany({ orderBy: { name: 'asc' } });
      assert.equal(users.length, 2);
      assert.ok(users.every((user) => user.phone === null && user.conversationIds.length === 3));
      assert.equal(await verifyPassword('disposable-old-a', users[0].passwordHash), true);
      assert.equal(await verifyPassword('disposable-old-b', users[1].passwordHash), true);
      const preserved = await legacy.message.findUnique({ where: { id: history } });
      assert.equal(preserved.content, 'Preserved old history');
      assert.equal(preserved.sendKey, `legacy:${history}`);
      const groups = await legacy.conversation.findMany({ where: { type: 'GROUP' } });
      assert.equal(new Set(groups.map((group) => group.conversationKey)).size, 2);
      assert.equal((await inspectDatabase(legacy)).conflicts.length, 0);
    });

    await t.test('duplicate users, duplicate/poisoned DMs and unreviewed bot identities are never silently merged', async () => {
      const conflicted = openDatabase('conflict').prisma;
      const ids = [newId(), newId(), newId()];
      await conflicted.$runCommandRaw({ insert: 'users', documents: ids.map((id, index) => ({ _id: oid(id), name: `conflict_${index}_${nonce}`, phone: 'disposable-conflict' })) });
      await conflicted.$runCommandRaw({ insert: 'conversations', documents: [
        ...Array.from({ length: 2 }, () => ({ _id: oid(newId()), type: 'DM', userIds: ids.slice(0, 2).map(oid), createdBy: oid(ids[0]), createdAt: date })),
        { _id: oid(newId()), type: 'DM', userIds: ids.map(oid), createdBy: oid(ids[0]), createdAt: date },
      ] });
      const report = await inspectDatabase(conflicted);
      assert.ok(report.conflicts.some((issue) => issue.kind === 'duplicateDmPair'));
      assert.ok(report.conflicts.some((issue) => issue.kind === 'poisonedDm'));
      await assert.rejects(migrateDatabase(conflicted, { reviewToken: report.reviewToken, acknowledgedBackup: true }), DatabaseSafetyError);
      assert.deepEqual((await inspectDatabase(conflicted)).counts, report.counts);
      const bots = openDatabase('bot').prisma;
      const botId = newId();
      await bots.$runCommandRaw({ insert: 'users', documents: [{ _id: oid(botId), name: 'FactBot', phone: 'old-disposable-bot-value' }] });
      const botReport = await inspectDatabase(bots);
      assert.ok(botReport.conflicts.some((issue) => issue.kind === 'reservedBotIdentity'));
      await assert.rejects(migrateDatabase(bots, { reviewToken: botReport.reviewToken, acknowledgedBackup: true }), DatabaseSafetyError);
      const reviewed = analyzeDatabase(await loadDatabaseSnapshot(bots), [botId]);
      await migrateDatabase(bots, { reviewToken: reviewed.reviewToken, acknowledgedBackup: true, approvedBots: [botId] });
      await provisionDatabase(bots);
      const bot = await bots.user.findUnique({ where: { id: botId } });
      assert.equal(bot.isBot, true);
      assert.equal(bot.passwordHash, null);
      assert.equal(bot.phone, null);
      const duplicateUsers = openDatabase('duplicate_users').prisma;
      await duplicateUsers.$runCommandRaw({ insert: 'users', documents: Array.from({ length: 2 }, () => ({ _id: oid(newId()), name: 'duplicate_fixture', phone: 'disposable-value' })) });
      const duplicates = await inspectDatabase(duplicateUsers);
      assert.ok(duplicates.conflicts.some((issue) => issue.kind === 'duplicateUsername'));
      await assert.rejects(migrateDatabase(duplicateUsers, { reviewToken: duplicates.reviewToken, acknowledgedBackup: true }), DatabaseSafetyError);
      assert.equal((await inspectDatabase(duplicateUsers)).counts.users, 2);
    });

    await t.test('test-only demo seed is repeatable and never overwrites a different password', async () => {
      const seed = openDatabase('seed');
      const env = { ...process.env, TEST_DATABASE_URL: seed.url.toString(), DEMO_PASSWORD_A: 'disposable-seed-a', DEMO_PASSWORD_B: 'disposable-seed-b' };
      const run = () => promisify(execFile)(process.execPath, ['--require', 'ts-node/register', 'scripts/seed-demo.cjs'], {
        cwd: path.resolve(__dirname, '../..'), env, timeout: 45_000, maxBuffer: 1024 * 1024,
      });
      const first = JSON.parse((await run()).stdout);
      const second = JSON.parse((await run()).stdout);
      assert.equal(first.dmId, second.dmId);
      assert.equal(first.groupId, second.groupId);
      assert.equal(await seed.prisma.user.count(), 2);
      assert.equal(await seed.prisma.message.count(), 2);
      env.DEMO_PASSWORD_A = 'a-different-disposable-password';
      await assert.rejects(run());
      assert.equal(await seed.prisma.user.count(), 2);
      assert.equal(await seed.prisma.message.count(), 2);
    });

    await t.test('Prisma CLI/config advisory libraries are never loaded by runtime HTTP/DB paths', () => {
      const loaded = Object.keys(require.cache).filter((file) => /node_modules[/\\](?:@prisma[/\\]config|effect|deepmerge-ts)[/\\]/.test(file));
      assert.deepEqual(loaded, []);
    });
  });
}
