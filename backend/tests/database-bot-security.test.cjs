const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Subject } = require('rxjs');
const { Logger } = require('@nestjs/common');
const { CONFIG } = require('../src/common/config');
const { analyzeDatabase } = require('../src/prisma/database');
const { databaseUrl } = require('../scripts/db-common.cjs');
const { BotService } = require('../src/bot/bot.service');
const { requestBounds, markRequestProcessing, RequestLifetimeInterceptor, SafeExceptionFilter } = require('../src/common/http-security');

const A = '64b8f9e2c4a3b12d4e5f6789';
const B = '64b8f9e2c4a3b12d4e5f6790';
const C = '64b8f9e2c4a3b12d4e5f6791';
const ROOM = '64b8f9e2c4a3b12d4e5f0001';
const oid = (id) => ({ $oid: id });
const date = { $date: '2026-11-01T12:00:00Z' };
function snapshot() {
  return { users: [A, B].map((id, index) => ({ _id: oid(id), name: `fixture_${index}`, isBot: false, hasHash: true,
    hasPhone: false, hasLegacyPassword: false, conversationIds: [oid(ROOM)] })),
  conversations: [{ _id: oid(ROOM), type: 'DM', userIds: [oid(A), oid(B)], createdBy: oid(A), createdAt: date,
    conversationKey: `dm:${A}:${B}`, activityAt: date, unreadCounts: { [A]: 0, [B]: 0 }, lastMessageAt: null,
    lastMessageId: null, hasLastMessagePreview: true }], messages: [], files: [] };
}

test('inspection reports legacy/conflicts without returning names or credentials', () => {
  const fixture = snapshot();
  fixture.users[0].hasHash = false;
  fixture.users[0].hasPhone = true;
  fixture.conversations[0].conversationKey = undefined;
  const report = analyzeDatabase(fixture);
  assert.equal(report.legacy.plaintextPasswords, 1);
  assert.equal(report.legacy.missingCredentials, 1);
  assert.equal(report.legacy.missingConversationKeys, 1);
  assert.equal(report.conflicts.length, 0);
  assert.ok(!JSON.stringify(report).includes('fixture_0'));
  assert.match(report.reviewToken, /^[0-9a-f]{64}$/);
  fixture.users[0].name = fixture.users[1].name;
  fixture.users.push({ _id: oid(C), name: 'fixture_third', isBot: false, hasHash: true, conversationIds: [] });
  fixture.conversations[0].userIds.push(oid(C));
  const conflicted = analyzeDatabase(fixture);
  assert.ok(conflicted.conflicts.some((issue) => issue.kind === 'duplicateUsername'));
  assert.ok(conflicted.conflicts.some((issue) => issue.kind === 'poisonedDm'));
});

test('duplicate DM histories and reserved human bot identities require review', () => {
  const fixture = snapshot();
  fixture.conversations.push({ ...fixture.conversations[0], _id: oid('64b8f9e2c4a3b12d4e5f0002') });
  fixture.users[0].name = 'FactBot';
  const report = analyzeDatabase(fixture);
  assert.ok(report.conflicts.some((issue) => issue.kind === 'duplicateDmPair'));
  assert.ok(report.conflicts.some((issue) => issue.kind === 'reservedBotIdentity'));
  assert.ok(!analyzeDatabase(fixture, [A]).conflicts.some((issue) => issue.kind === 'reservedBotIdentity'));
});

test('integration and seed URLs refuse ordinary databases, default ports and nonlocal hosts', () => {
  const previous = { DATABASE_URL: process.env.DATABASE_URL, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL };
  try {
    process.env.DATABASE_URL = 'mongodb://127.0.0.1:27017/chatapp?replicaSet=rs0';
    for (const url of ['mongodb://127.0.0.1:27017/test_fixture?replicaSet=rs0', 'mongodb://127.0.0.1:27027/chatapp?replicaSet=rs0',
      'mongodb://remote.example.test:27027/test_fixture?replicaSet=rs0', 'mongodb://127.0.0.1:27027/test_fixture']) {
      process.env.TEST_DATABASE_URL = url;
      assert.throws(() => databaseUrl('TEST_DATABASE_URL', true));
    }
    process.env.TEST_DATABASE_URL = 'mongodb://127.0.0.1:27027/test_fixture?replicaSet=rs0';
    assert.equal(databaseUrl('TEST_DATABASE_URL', true), process.env.TEST_DATABASE_URL);
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    assert.equal(databaseUrl('TEST_DATABASE_URL', true), process.env.TEST_DATABASE_URL);
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('bot ticks are non-overlapping, batch-bounded and stopped on destroy', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  let sends = 0;
  const bot = new BotService({ user: { findMany: async ({ take }) => { reads++; assert.equal(take, CONFIG.botBatchSize); return [{ id: A }, { id: B }]; } } },
    { createConversation: async () => ({ id: ROOM }) }, { createMessage: async () => { sends++; if (sends === 1) await held; } });
  bot.botUserId = C;
  const first = bot.tick();
  await new Promise(setImmediate);
  await Promise.all(Array.from({ length: 8 }, () => bot.tick()));
  assert.equal(reads, 1);
  assert.equal(sends, 1);
  release();
  await first;
  assert.equal(sends, 2);
  bot.onModuleDestroy();
  await bot.tick();
  assert.equal(reads, 1);
});

test('bot startup rejects a preclaimed human identity and creates no usable credentials', async (t) => {
  t.mock.method(Logger.prototype, 'log', () => {});
  const bad = new BotService({ user: { findUnique: async () => ({ id: C, name: 'FactBot', isBot: false, phone: 'legacy_test_value' }) } }, {}, {});
  await assert.rejects(bad.onModuleInit(), /requires reviewed migration/);
  let created;
  const good = new BotService({ user: { findUnique: async () => null, create: async ({ data }) => { created = data; return { ...data, id: C }; } } }, {}, {});
  await good.onModuleInit();
  good.onModuleDestroy();
  assert.equal(created.isBot, true);
  assert.equal(created.phone, null);
  assert.equal(created.passwordHash, null);
});

function httpFixture(path = '/message', method = 'POST') {
  const request = { path, method, headers: {}, hostname: 'localhost', secure: false, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } };
  const response = new EventEmitter();
  response.headers = {};
  response.setHeader = (key, value) => { response.headers[key] = value; };
  response.status = (code) => { response.code = code; return response; };
  response.json = (body) => { response.body = body; return response; };
  return { request, response };
}

test('request/upload capacity remains held after client disconnect until work finishes', () => {
  const previous = { ...CONFIG };
  try {
    Object.assign(CONFIG, { allowLocalHttp: true, maxConcurrentUploads: 1, maxConcurrentRequests: 8 });
    const bound = requestBounds();
    const first = httpFixture();
    bound(first.request, first.response, () => {});
    markRequestProcessing(first.request);
    first.response.destroyed = true;
    first.response.emit('close');
    const blocked = httpFixture();
    bound(blocked.request, blocked.response, () => assert.fail('capacity should still be held'));
    assert.equal(blocked.response.code, 429);
    const subject = new Subject();
    new RequestLifetimeInterceptor().intercept({ switchToHttp: () => ({ getRequest: () => first.request, getResponse: () => first.response }) },
      { handle: () => subject }).subscribe();
    subject.complete();
    let allowed = false;
    const next = httpFixture();
    bound(next.request, next.response, () => { allowed = true; });
    assert.equal(allowed, true);
    next.response.emit('finish');
  } finally { Object.assign(CONFIG, previous); }
});

test('unhandled errors never log private message/credential/control-character detail', (t) => {
  const logs = [];
  t.mock.method(Logger.prototype, 'error', (...values) => logs.push(values.join(' ')));
  const fixture = httpFixture();
  const secret = 'PRIVATE_MESSAGE credential=never-log-this\u001b[31m';
  new SafeExceptionFilter().catch(new Error(secret), { switchToHttp: () => ({ getRequest: () => fixture.request, getResponse: () => fixture.response }) });
  assert.equal(fixture.response.code, 500);
  assert.ok(logs.length > 0);
  assert.ok(!logs.join('').includes(secret));
  assert.ok(!JSON.stringify(fixture.response.body).includes('never-log-this'));
});

test('global body budget accounts for decoded, not compressed, request sizes', () => {
  const previous = { ...CONFIG };
  try {
    Object.assign(CONFIG, { allowLocalHttp: true });
    const bound = requestBounds(1024 * 1024);
    const held = [];
    for (let index = 0; index < 2; index++) {
      const fixture = httpFixture();
      fixture.request.headers['content-length'] = String(512 * 1024);
      bound(fixture.request, fixture.response, () => {});
      held.push(fixture);
    }
    const blocked = httpFixture();
    blocked.request.headers['content-length'] = String(512 * 1024);
    bound(blocked.request, blocked.response, () => assert.fail('body budget must be bounded'));
    assert.equal(blocked.response.code, 429);
    const compressed = httpFixture();
    compressed.request.headers['content-encoding'] = 'gzip';
    bound(compressed.request, compressed.response, () => assert.fail('compressed JSON must not bypass decoded reservations'));
    assert.equal(compressed.response.code, 429);
    for (const fixture of held) fixture.response.emit('finish');
  } finally { Object.assign(CONFIG, previous); }
});
