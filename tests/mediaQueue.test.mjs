import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaReadQueue, sessionMediaReadQueue, waitForMediaRetry } from '../src/utils/mediaReadQueue.ts';
import { getApiConfig, setApiConfig } from '../src/api/config.ts';
import { messageApi } from '../src/api/messageApi.ts';

test('limits protected photos and history reads to two and releases a permit only once', async () => {
  const queue = createMediaReadQueue();
  const first = await queue.acquire();
  const second = await queue.acquire();
  let granted = false;
  const third = queue.acquire().then((release) => { granted = true; return release; });
  await Promise.resolve();
  assert.equal(granted, false);
  first();
  first();
  const thirdRelease = await third;
  let fourthGranted = false;
  const fourth = queue.acquire().then((release) => { fourthGranted = true; return release; });
  await Promise.resolve();
  assert.equal(fourthGranted, false);
  second();
  const fourthRelease = await fourth;
  thirdRelease(); fourthRelease();
});

test('cancelled queued images never acquire a slot or prevent the next visible image', async () => {
  const queue = createMediaReadQueue(1);
  const active = await queue.acquire();
  const controller = new AbortController();
  const cancelled = assert.rejects(queue.acquire([controller.signal]), (error) => error.name === 'AbortError');
  controller.abort();
  await cancelled;
  const next = queue.acquire();
  active();
  (await next)();
  await assert.rejects(queue.acquire([controller.signal]), (error) => error.name === 'AbortError');
});

test('read queues are session-scoped even when account/server settings are otherwise equal', () => {
  const first = new AbortController();
  const second = new AbortController();
  assert.equal(sessionMediaReadQueue({ signal: first.signal }), sessionMediaReadQueue({ signal: first.signal }));
  assert.notEqual(sessionMediaReadQueue({ signal: first.signal }), sessionMediaReadQueue({ signal: second.signal }));
});

test('a server switch aborts history waiting behind photos before any request or credential transmission', async (t) => {
  setApiConfig({ baseUrl: 'https://old.test', username: 'old', password: 'old-secret', sessionKey: 'old-queued' });
  const config = getApiConfig();
  const queue = sessionMediaReadQueue(config);
  const first = await queue.acquire();
  const second = await queue.acquire();
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not fetch'); });
  const pending = assert.rejects(messageApi.getMessages({ conversation_id: 'chat' }, { config }), (error) => error.name === 'AbortError');
  setApiConfig({ baseUrl: 'https://new.test', username: '', password: '', sessionKey: 'new-queued' });
  await pending;
  assert.equal(fetch.mock.callCount(), 0);
  first(); second();
});

test('bounded GET throttling waits can be cancelled immediately on scroll or session exit', async () => {
  const controller = new AbortController();
  const pending = assert.rejects(waitForMediaRetry(1000, [controller.signal]), (error) => error.name === 'AbortError');
  controller.abort();
  await pending;
});
