import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { setApiConfig } from '../src/api/config.ts';
import { messageApi } from '../src/api/messageApi.ts';
import { parseConversation, parseMessagePage, parseCapabilities } from '../src/api/validation.ts';

const UUID = '11111111-1111-4111-8111-111111111111';
const capabilities = { idempotency: true, receipts: true, conversationSummary: true };
const CONFIG = { baseUrl: 'https://chat.test', username: 'me', password: 'secret', capabilities };
const MESSAGE = { id: 'server', senderId: 'me', conversationId: 'chat', createdAt: '2026-11-22T08:00:00.000Z', status: {} };
afterEach(() => setApiConfig({ ...CONFIG, username: '', password: '' }));

test('only sends client_message_id in an explicitly included, capability-supported session', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ...MESSAGE, clientMessageId: UUID }), { headers: { 'Content-Type': 'application/json' } }));
  const payload = { conversation_id: 'chat', content: 'Hello', client_message_id: UUID };
  setApiConfig({ ...CONFIG, backendMode: 'legacy' });
  await messageApi.sendMessage(payload);
  assert.deepEqual(JSON.parse(fetch.mock.calls[0].arguments[1].body), { conversation_id: 'chat', content: 'Hello' });
  setApiConfig({ ...CONFIG, backendMode: 'included', capabilities: { ...capabilities, idempotency: false } });
  await messageApi.sendMessage(payload);
  assert.equal(JSON.parse(fetch.mock.calls[1].arguments[1].body).client_message_id, undefined);
  setApiConfig({ ...CONFIG, backendMode: 'included' });
  assert.equal((await messageApi.sendMessage(payload)).clientMessageId, UUID);
  assert.equal(JSON.parse(fetch.mock.calls[2].arguments[1].body).client_message_id, UUID);
});

test('legacy sessions never issue acknowledgements; included receipt batches are bounded', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{"status":"ok","acknowledged":1}', { headers: { 'Content-Type': 'application/json' } }));
  const payload = { conversation_id: 'chat', message_ids: ['message'], status: 'read' };
  setApiConfig({ ...CONFIG, backendMode: 'legacy' });
  await messageApi.acknowledge(payload);
  assert.equal(fetch.mock.callCount(), 0);
  setApiConfig({ ...CONFIG, backendMode: 'included' });
  await messageApi.acknowledge(payload);
  assert.equal(fetch.mock.calls[0].arguments[0], 'https://chat.test/message/acknowledge');
  await assert.rejects(messageApi.acknowledge({ ...payload, message_ids: Array(101).fill('message') }), /1 to 100/);
});

test('does not invent successful receipts from malformed or partial acknowledgements', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{"status":"ok","acknowledged":0}', { headers: { 'Content-Type': 'application/json' } }));
  setApiConfig({ ...CONFIG, backendMode: 'included' });
  const payload = { conversation_id: 'chat', message_ids: ['message'], status: 'read' };
  await assert.rejects(messageApi.acknowledge(payload), /did not confirm/);
  fetch.mock.mockImplementation(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(messageApi.acknowledge(payload), /did not confirm/);
});

test('legacy mode does not assume stored-file extension payloads are accepted', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(MESSAGE), { headers: { 'Content-Type': 'application/json' } }));
  setApiConfig({ ...CONFIG, backendMode: 'legacy' });
  await assert.rejects(messageApi.sendMessage({ conversation_id: 'chat', file_id: 'file' }), /inline photos/);
  assert.equal(fetch.mock.callCount(), 0);
  await messageApi.sendMessage({ conversation_id: 'chat', imageInfo: 'data:image/png;base64,aGVsbG8=', file_id: 'file' });
  assert.equal(JSON.parse(fetch.mock.calls[0].arguments[1].body).file_id, undefined);
});

test('schema validation rejects wrong-conversation messages and malformed API pages/health', () => {
  assert.throws(() => parseMessagePage({ data: [MESSAGE], count: 1, nextCursor: null }, 'another'), /different conversation/);
  assert.throws(() => parseMessagePage({ data: 'HTML', count: 1 }, 'chat'), /history response/);
  assert.throws(() => parseCapabilities({ status: 'ok' }), /capabilities/);
  assert.deepEqual(parseCapabilities({ status: 'ok', capabilities, version: '1.1.0', apiVersion: 1 }), capabilities);
  const conversation = parseConversation({ id: 'chat', type: 'DM', name: 'old global name', createdAt: MESSAGE.createdAt,
    createdBy: 'me', participants_ids: ['me', 'other', 'other'], lastMessageAt: null, lastMessagePreview: null, unreadCount: 0 });
  assert.equal(conversation.participants_ids.length, 2);
});
