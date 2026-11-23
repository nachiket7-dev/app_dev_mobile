import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import { apiFetch, getApiConfig, getAuthHeader, setApiConfig } from '../src/api/config.ts';
import { createSessionGuard, safeReturnPath, sessionKey } from '../src/utils/session.ts';
import { normalizeServerUrl } from '../src/utils/server.ts';
import { getServerCapabilities, testServerConnection } from '../src/api/serverApi.ts';
import { parseUser } from '../src/api/validation.ts';

const CONFIG = { baseUrl: 'https://old.chat.test', username: 'old-user', password: 'old-secret', sessionKey: 'old' };
beforeEach(() => setApiConfig(CONFIG));
afterEach(() => setApiConfig({ ...CONFIG, username: '', password: '' }));

test('invalidates old login success, catch, and finally independently of the transport', () => {
  const guard = createSessionGuard();
  const first = guard.begin();
  const second = guard.begin();
  assert.equal(first.signal.aborted, true);
  const state = { user: 'new-user', error: null, loading: true };
  if (guard.isCurrent(first)) state.user = 'late-old-user';
  if (guard.isCurrent(first)) state.error = 'late-old-error';
  if (guard.isCurrent(first)) state.loading = false;
  assert.deepEqual(state, { user: 'new-user', error: null, loading: true });
  assert.equal(guard.isCurrent(second), true);
  guard.invalidate();
  assert.equal(second.signal.aborted, true);
  assert.equal(guard.isCurrent(second), false);
});

test('separates same-account relogins and different accounts/servers in cache scopes', () => {
  const scopes = [sessionKey('https://a.test', 'me', 1), sessionKey('https://a.test', 'me', 2),
    sessionKey('https://a.test', 'other', 1), sessionKey('https://b.test', 'me', 1)];
  assert.equal(new Set(scopes).size, 4);
  assert.equal(scopes.some((scope) => scope.includes('secret')), false);
});

test('retains only valid private route destinations after sign-in', () => {
  assert.equal(safeReturnPath('/chat/abc123'), '/chat/abc123');
  assert.equal(safeReturnPath('/new-chat'), '/new-chat');
  for (const value of ['https://evil.test', '//evil.test', '/chat/../settings', ['/chat/a'], undefined]) {
    assert.equal(safeReturnPath(value), '/chats');
  }
});

test('accepts full HTTPS and development LAN, emulator, IPv6, and base-path URLs', () => {
  assert.equal(normalizeServerUrl(' https://chat.example.edu/api/// '), 'https://chat.example.edu/api');
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://10.0.2.2:3000',
    'http://192.168.1.50:3000/api', 'http://172.16.0.2:3000', 'http://[::1]:3000', 'http://mymac.local:3000']) {
    assert.equal(normalizeServerUrl(url, true), url);
    assert.throws(() => normalizeServerUrl(url), /HTTPS is required/);
  }
  for (const url of ['http://example.edu:3000', 'https://user:secret@chat.test', 'https://chat.test?q=secret',
    'https://chat.test#fragment', 'file:///private', 'chat.test:3000', 'https://chat.test\n']) {
    assert.throws(() => normalizeServerUrl(url, true));
  }
});

test('a server switch clears credentials and aborts prior requests without sending to the new host', async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    await pending;
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  });
  const request = apiFetch('/user/profile');
  const rejected = assert.rejects(request, (error) => error.name === 'AbortError');
  setApiConfig({ baseUrl: 'https://new.chat.test', sessionKey: 'new' });
  assert.equal(getAuthHeader(), null);
  assert.equal(fetch.mock.calls[0].arguments[1].signal.aborted, true);
  release();
  await rejected;
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(fetch.mock.calls[0].arguments[0], 'https://old.chat.test/user/profile');
});

test('tests the edited included server without global changes, cookies, redirects, or credentials', async (t) => {
  const before = getApiConfig();
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    status: 'ok', capabilities: { idempotency: true, receipts: true, conversationSummary: true },
  }), { headers: { 'Content-Type': 'application/json' } }));
  assert.match(await testServerConnection('https://edited.chat.test', 'included'), /No credentials were sent/);
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, 'https://edited.chat.test/health');
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(getApiConfig(), before);
  assert.equal(getAuthHeader(), 'Basic old-user:old-secret');
});

test('explicit public requests strip supplied authorization and respect header casing', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  await apiFetch('/health', { authenticated: false, headers: { authorization: 'Basic old-user:old-secret', 'content-type': 'application/json' }, body: '{}' });
  const headers = fetch.mock.calls[0].arguments[1].headers;
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['Content-Type'], undefined);
});

test('legacy connection tests use only the old profile endpoint and no credentials', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{"message":"Unauthorized"}', {
    status: 401, headers: { 'Content-Type': 'application/json' },
  }));
  assert.match(await testServerConnection('https://legacy.chat.test', 'legacy'), /reach|reachable/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(fetch.mock.calls[0].arguments[0], 'https://legacy.chat.test/user/profile');
  assert.equal(fetch.mock.calls[0].arguments[1].headers.Authorization, undefined);
});

test('does not authenticate HTML-200 or malformed JSON profiles/capabilities', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Welcome</html>', { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(testServerConnection('https://wrong.chat.test', 'included'), /non-JSON/);
  await assert.rejects(getServerCapabilities({ config: { baseUrl: 'https://wrong.chat.test' } }), /non-JSON/);
  assert.throws(() => parseUser({ name: 'Me', password: 'do-not-cache' }), /user ID/);
  assert.deepEqual(parseUser({ id: 'me', name: 'Me', bio: null, password: 'do-not-cache' }), { id: 'me', name: 'Me', bio: null });
});
