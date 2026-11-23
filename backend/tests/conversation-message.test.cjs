const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Prisma } = require('@prisma/client');
const { randomUUID } = require('node:crypto');
const { ConversationService } = require('../src/conversation/conversation.service');
const { MessageService } = require('../src/message/message.service');
const { inTransaction } = require('../src/prisma/transaction');

const A = '64b8f9e2c4a3b12d4e5f6789';
const B = '64b8f9e2c4a3b12d4e5f6790';
const C = '64b8f9e2c4a3b12d4e5f6791';
const ROOM = '64b8f9e2c4a3b12d4e5f0001';
const OTHER_ROOM = '64b8f9e2c4a3b12d4e5f0002';
const date = new Date('2026-11-01T12:00:00Z');
const conversation = () => ({ id: ROOM, name: null, type: 'DM', createdAt: date, createdBy: A,
  participants_ids: [A, B], conversationKey: `dm:${A}:${B}`, activityAt: date,
  lastMessageAt: null, lastMessageId: null, lastMessagePreview: null, unreadCounts: { [A]: 0, [B]: 0 } });
const message = (index, overrides = {}) => ({ id: `64b8f9e2c4a3b12d${index.toString(16).padStart(8, '0')}`,
  content: `message ${index}`, imageInfo: null, createdAt: date, senderId: A, conversationId: ROOM,
  status: { [A]: { delivered: true, read: true }, [B]: { delivered: false, read: false } }, fileId: null, clientMessageId: null, ...overrides });
const projected = (record, select) => Object.fromEntries(Object.keys(select).map((key) => [key, record[key]]));

test('multi-member DMs fail before DB access, including legacy recipient combinations', async () => {
  const service = new ConversationService({});
  await assert.rejects(service.createConversation({ type: 'DM', participants_ids: [B, C] }, A), (error) => error.getStatus() === 400);
  await assert.rejects(service.createConversation({ type: 'DM', participants_ids: [C], recipient_id: B }, A), (error) => error.getStatus() === 400);
  await assert.rejects(service.createConversation({ participants_ids: [A.toUpperCase()] }, A), (error) => error.getStatus() === 400);
});

test('canonical DM creation uses one key and links only the winning conversation', async () => {
  let stored;
  let links = 0;
  const prisma = { conversation: {
    findUnique: async () => { await new Promise(setImmediate); return stored ?? null; },
    create: async ({ data }) => {
      if (stored) throw new Prisma.PrismaClientKnownRequestError('collision', { code: 'P2002', clientVersion: '6.19.3' });
      stored = { ...conversation(), ...data };
      return stored;
    },
  }, user: { count: async () => 2, updateMany: async () => { links++; } } };
  prisma.$transaction = async (operation) => operation(prisma);
  const service = new ConversationService(prisma);
  const results = await Promise.all(Array.from({ length: 8 }, () => service.createConversation({ type: 'DM', participants_ids: [B.toUpperCase(), A.toUpperCase(), B] }, A)));
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(links, 1);
  assert.deepEqual(stored.participants_ids, [A, B]);
  assert.equal(stored.conversationKey, `dm:${A}:${B}`);
  assert.equal(results[0].conversationKey, undefined);
});

test('poisoned existing DMs are not returned, even if their key looks canonical', async () => {
  const prisma = { conversation: { findUnique: async () => ({ ...conversation(), participants_ids: [A, B, C] }) } };
  prisma.$transaction = async (operation) => operation(prisma);
  const service = new ConversationService(prisma);
  await assert.rejects(service.createConversation({ recipient_id: B }, A), (error) => error.getStatus() === 409);
});

test('membership precedes message reads, attachment metadata and image decoding', async () => {
  const service = new MessageService({
    conversation: { findUnique: async () => conversation() },
    message: { findMany: () => { throw new Error('must not load messages'); } },
    file: { findUnique: () => { throw new Error('must not load files'); } },
  });
  await assert.rejects(service.getMessages(ROOM, C), (error) => error.getStatus() === 403);
  await assert.rejects(service.createMessage({ conversation_id: ROOM, imageInfo: 'invalid!' }, C), (error) => error.getStatus() === 403);
});

test('pagination binds cursors to the room and fetches an extra row with time/id ordering', async () => {
  let query;
  let rows = Array.from({ length: 20 }, (_, index) => message(20 - index));
  const prisma = {
    conversation: { findUnique: async () => conversation() },
    message: { findUnique: async () => message(1, { conversationId: OTHER_ROOM }), findMany: async (input) => { query = input; return rows; } },
  };
  const service = new MessageService(prisma);
  const page = await service.getMessages(ROOM, A);
  assert.equal(query.take, 21);
  assert.deepEqual(query.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  assert.equal(page.nextCursor, null);
  assert.equal(page.data[0].id, message(1).id);
  rows = Array.from({ length: 21 }, (_, index) => message(21 - index));
  const more = await service.getMessages(ROOM, A);
  assert.equal(more.nextCursor, message(2).id);
  assert.equal(more.count, 20);
  await assert.rejects(service.getMessages(ROOM, A, message(1).id), (error) => error.getStatus() === 400);
  prisma.message.findUnique = async () => message(10);
  await service.getMessages(ROOM, A, message(10).id);
  assert.deepEqual(query.where.OR, [{ createdAt: { lt: date } }, { createdAt: date, id: { lt: message(10).id } }]);
});

function messageStore() {
  const room = conversation();
  const messages = [];
  let transaction = false;
  const prisma = { conversation: {
    findUnique: async () => structuredClone(room),
    update: async ({ data }) => { assert.equal(transaction, true); Object.assign(room, data); return { id: ROOM }; },
  }, message: {
    findUnique: async ({ where, select }) => { const row = messages.find((entry) => entry.sendKey === where.sendKey); return row ? projected(row, select) : null; },
    create: async ({ data, select }) => { assert.equal(transaction, true); const row = message(messages.length + 1, data); messages.push(row); return projected(row, select); },
    findMany: async ({ where }) => messages.filter((entry) => where.id.in.includes(entry.id) && entry.conversationId === where.conversationId).map((entry) => structuredClone(entry)),
    update: async ({ where, data }) => { assert.equal(transaction, true); Object.assign(messages.find((entry) => entry.id === where.id), data); return { id: where.id }; },
  } };
  prisma.$runCommandRaw = async ({ update, updates }) => {
    assert.equal(transaction, true);
    assert.equal(update, 'messages');
    for (const operation of updates) {
      const row = messages.find((entry) => entry.id === operation.q._id.$oid && entry.conversationId === operation.q.conversationId.$oid);
      assert.ok(row);
      for (const [path, value] of Object.entries(operation.u.$set)) {
        const [field, caller, property] = path.split('.');
        assert.equal(field, 'status');
        row.status[caller] ??= { delivered: false, read: false };
        row.status[caller][property] = value;
      }
    }
    return { n: updates.length };
  };
  prisma.$transaction = async (operation) => { transaction = true; try { return await operation(prisma); } finally { transaction = false; } };
  return { prisma, room, messages };
}

test('retry-safe messages return one committed message and update summaries exactly once', async () => {
  const store = messageStore();
  const service = new MessageService(store.prisma);
  const dto = { conversation_id: ROOM, content: 'Private fixture text', client_message_id: randomUUID() };
  const first = await service.createMessage(dto, A);
  const replay = await service.createMessage(dto, A);
  assert.equal(first.id, replay.id);
  assert.equal(first.clientMessageId, dto.client_message_id);
  assert.equal(first.sendKey, undefined);
  assert.equal(store.messages.length, 1);
  assert.equal(store.room.unreadCounts[B], 1);
  assert.equal(store.room.lastMessagePreview, dto.content);
  await assert.rejects(service.createMessage({ ...dto, content: 'conflicting reuse' }, A), (error) => error.getStatus() === 409);
  await service.createMessage({ conversation_id: ROOM, content: 'legacy send' }, A);
  await service.createMessage({ conversation_id: ROOM, content: 'legacy send' }, A);
  assert.equal(new Set(store.messages.map((entry) => entry.sendKey)).size, 3);
});

test('delivery/read acknowledgements are caller-only, monotonic and idempotent', async () => {
  const store = messageStore();
  const service = new MessageService(store.prisma);
  const sent = await service.createMessage({ conversation_id: ROOM, content: 'ack fixture' }, A);
  const dto = { conversation_id: ROOM, message_ids: [sent.id], status: 'delivered' };
  await service.acknowledge(dto, B);
  assert.deepEqual(store.messages[0].status[B], { delivered: true, read: false });
  assert.equal(store.room.unreadCounts[B], 1);
  await service.acknowledge({ ...dto, status: 'read' }, B);
  await service.acknowledge({ ...dto, status: 'read' }, B);
  await service.acknowledge(dto, B);
  assert.deepEqual(store.messages[0].status[B], { delivered: true, read: true });
  assert.deepEqual(store.messages[0].status[A], { delivered: true, read: true });
  assert.equal(store.room.unreadCounts[B], 0);
  await assert.rejects(service.acknowledge(dto, C), (error) => error.getStatus() === 403);
  await assert.rejects(service.acknowledge({ ...dto, message_ids: [message(999).id] }, B), (error) => error.getStatus() === 400);
  await assert.rejects(service.acknowledge({ ...dto, message_ids: Array(101).fill(sent.id) }, B), (error) => error.getStatus() === 400);
});

test('transaction conflicts retry only known rolled-back transactions', async () => {
  let calls = 0;
  const prisma = { $transaction: async (operation) => {
    calls++;
    if (calls < 3) throw new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: '6.19.3' });
    return operation({});
  } };
  assert.equal(await inTransaction(prisma, async () => 'ok'), 'ok');
  assert.equal(calls, 3);
  calls = 0;
  prisma.$transaction = async (operation) => {
    calls++;
    if (calls === 1) throw new Prisma.PrismaClientKnownRequestError('raw transaction WriteConflict', { code: 'P2010', clientVersion: '6.19.3', meta: { code: '112' } });
    return operation({});
  };
  assert.equal(await inTransaction(prisma, async () => 'raw retry ok'), 'raw retry ok');
  assert.equal(calls, 2);
  calls = 0;
  prisma.$transaction = async () => { calls++; throw new Error('uncertain commit'); };
  await assert.rejects(inTransaction(prisma, async () => 'unsafe retry'));
  assert.equal(calls, 1);
});
