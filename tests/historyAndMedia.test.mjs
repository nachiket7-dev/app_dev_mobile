import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyHistory, mergeMessagePage, mergeHistoryGap, conversationTitle, selectReceiptIds } from '../src/utils/messageHistory.ts';
import { isImageMessage, preparePickedPhoto, resolveMessageImage, PHOTO_BYTE_LIMIT } from '../src/utils/privateMedia.ts';
import { apiFetch, MAX_PHOTO_BYTES, setApiConfig } from '../src/api/config.ts';

const TIME = '2026-11-22T08:00:00.000Z';
const message = (n, changes = {}) => ({ id: `m${String(n).padStart(3, '0')}`, senderId: 'other', conversationId: 'chat',
  createdAt: TIME, content: String(n), status: {}, ...changes });
const page = (start, end, nextCursor) => ({ data: Array.from({ length: end - start + 1 }, (_, i) => message(start + i)).reverse(), count: end - start + 1, nextCursor });

test('loads 100 same-timestamp messages with stable IDs/order and no cursor resets on polling', () => {
  let history = mergeMessagePage(emptyHistory(), page(81, 100, 'cursor80'));
  history = mergeMessagePage(history, page(61, 80, 'cursor60'), 'older');
  history = mergeMessagePage(history, page(91, 110, 'cursor90'));
  assert.equal(history.data.length, 50);
  assert.equal(history.nextCursor, 'cursor60');
  history = mergeMessagePage(history, page(41, 60, 'cursor40'), 'older');
  history = mergeMessagePage(history, page(21, 40, 'cursor20'), 'older');
  history = mergeMessagePage(history, page(1, 20, null), 'older');
  assert.equal(history.data.length, 110);
  assert.equal(history.nextCursor, null);
  assert.deepEqual(history.data.map((item) => item.id), Array.from({ length: 110 }, (_, i) => message(i + 1).id));
  assert.equal(mergeMessagePage(history, page(91, 110, 'cursor90')).data.length, 110);
  assert.equal(mergeMessagePage(history, page(91, 110, 'cursor90')).nextCursor, null);
});

test('overlapping polling/sends do not lose older rows or downgrade successful receipts', () => {
  let history = mergeMessagePage(emptyHistory(), { data: [message(1, { status: { me: { delivered: true, read: true } } })], count: 1, nextCursor: 'older' });
  history = mergeMessagePage(history, { data: [message(1, { status: { me: { delivered: false, read: false } } }), message(2)], count: 2, nextCursor: 'newer' });
  assert.deepEqual(history.data[0].status.me, { delivered: true, read: true });
  assert.equal(history.nextCursor, 'older');
  const sentFirst = mergeMessagePage(emptyHistory(), { data: [message(2)], count: 1 }, 'sent');
  assert.equal(sentFirst.initialized, false);
  assert.equal(mergeMessagePage(sentFirst, page(1, 2, 'old')).nextCursor, 'old');
});

test('bridges multi-page bursts without resetting the oldest loaded cursor or refetching retained pages', () => {
  let history = mergeMessagePage(emptyHistory(), page(1, 20, 'old-cursor'));
  history = mergeMessagePage(history, page(101, 120, 'cursor100'));
  assert.deepEqual(history.gaps, [{ cursor: 'cursor100', untilId: 'm020' }]);
  for (const [start, end, cursor, next] of [[81, 100, 'cursor100', 'cursor80'], [61, 80, 'cursor80', 'cursor60'],
    [41, 60, 'cursor60', 'cursor40'], [21, 40, 'cursor40', 'cursor20'], [1, 20, 'cursor20', 'old-cursor']]) {
    history = mergeHistoryGap(history, page(start, end, next), cursor);
  }
  assert.equal(history.data.length, 120);
  assert.deepEqual(history.gaps, []);
  assert.equal(history.nextCursor, 'old-cursor');
  assert.deepEqual(mergeMessagePage(history, page(101, 120, 'cursor100')).gaps, []);
});

test('DM titles always name the counterpart, not a shared/global DM name', () => {
  const names = new Map([['me', 'Me'], ['other', 'Other']]);
  assert.equal(conversationTitle({ type: 'DM', name: 'Me', participants_ids: ['me', 'other'] }, 'me', names), 'Other');
  assert.equal(conversationTitle({ type: 'GROUP', name: 'Project', participants_ids: ['me', 'other'] }, 'me', names), 'Project');
});

test('read acknowledgements require focused active visible incoming rows; batches never exceed 100', () => {
  const messages = Array.from({ length: 205 }, (_, i) => message(i + 1));
  messages.push(message(300, { senderId: 'me' }));
  const visible = new Set(['m001', 'm002', 'm300']);
  assert.deepEqual(selectReceiptIds(messages, 'me', 'read', false, visible), []);
  assert.deepEqual(selectReceiptIds(messages, 'me', 'read', true, visible), ['m001', 'm002']);
  assert.equal(selectReceiptIds(messages, 'me', 'delivered', true, visible).length, 100);
  assert.deepEqual(selectReceiptIds(messages, 'me', 'read', true, visible, new Set(['m001'])), ['m002']);
});

test('FILE never becomes an image, and private photos stay on the selected API origin', () => {
  const base = 'https://chat.test/api';
  assert.equal(isImageMessage(message(1, { type: 'FILE', fileId: 'file', imageInfo: 'data:image/png;base64,aGVsbG8=' })), false);
  assert.equal(resolveMessageImage(message(1, { type: 'FILE', fileId: 'file' }), base), null);
  assert.deepEqual(resolveMessageImage(message(1, { type: 'IMAGE', fileId: 'file' }), base), { uri: `${base}/file/file/download`, authenticated: true });
  assert.equal(resolveMessageImage(message(1, { type: 'IMAGE', imageInfo: 'https://other.test/private' }), base), null);
  assert.equal(resolveMessageImage(message(1, { type: 'IMAGE', imageInfo: 'https://user:secret@chat.test/api/photo' }), base), null);
  assert.equal(resolveMessageImage(message(1, { type: 'IMAGE', imageInfo: 'https://chat.test/api/photo?password=secret' }), base), null);
  assert.equal(resolveMessageImage(message(1, { type: 'IMAGE', imageInfo: 'data:image/svg+xml;base64,aGVsbG8=' }), base), null);
  assert.equal(resolveMessageImage(message(1, { imageInfo: 'data:image/png;base64,aGVsbG8=' }), base).authenticated, false);
});

test('normalizes SDK58 JPEG bytes/original PNG MIME and reports oversized/missing media clearly', () => {
  const photo = preparePickedPhoto({ base64: '/9j/AA==', mimeType: 'image/png', fileName: 'original.png' });
  assert.equal(photo.mimeType, 'image/jpeg');
  assert.equal(photo.data, 'data:image/jpeg;base64,/9j/AA==');
  assert.throws(() => preparePickedPhoto({}), /caption has been kept/);
  assert.throws(() => preparePickedPhoto({ base64: 'aaaa', width: 10000, height: 10000 }), /smaller photo/);
  assert.throws(() => preparePickedPhoto({ base64: 'a'.repeat(Math.ceil(PHOTO_BYTE_LIMIT * 4 / 3) + 8) }), /smaller photo/);
});

test('fetches protected web photos with auth into bounded blobs, and rejects HTML or oversized media', async (t) => {
  setApiConfig({ baseUrl: 'https://chat.test', username: 'me', password: 'secret', sessionKey: 'media' });
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }));
  const blob = await apiFetch('/file/photo/download', { responseType: 'image' });
  assert.equal(blob.size, 3);
  assert.equal(blob.type, 'image/png');
  assert.equal(fetch.mock.calls[0].arguments[1].headers.Authorization, 'Basic me:secret');
  fetch.mock.mockImplementation(async () => new Response('<html>not an image</html>', { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(apiFetch('/file/photo/download', { responseType: 'image' }), /supported photo/);
  fetch.mock.mockImplementation(async () => new Response('small', { headers: { 'Content-Type': 'image/png', 'Content-Length': String(MAX_PHOTO_BYTES + 1) } }));
  await assert.rejects(apiFetch('/file/photo/download', { responseType: 'image' }), /10 MB/);
  setApiConfig({ username: '', password: '' });
});
