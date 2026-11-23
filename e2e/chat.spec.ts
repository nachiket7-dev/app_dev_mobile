import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const api = (process.env.E2E_API_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(api).hostname)) {
  throw new Error('Browser fixtures may only target an explicitly local test API.');
}

type Actor = { id: string; name: string; password: string };
const auth = (actor: Actor) => ({ Authorization: `Basic ${actor.name}:${actor.password}` });

async function actor(request: APIRequestContext, suffix: string): Promise<Actor> {
  const name = `e2e_${randomUUID().slice(0, 8)}_${suffix}`;
  const password = `test-only-${randomUUID()}`;
  const response = await request.get(`${api}/user/profile`, { headers: { Authorization: `Basic ${name}:${password}` } });
  expect(response.status()).toBe(200);
  return { ...(await response.json()), password };
}

async function post(request: APIRequestContext, user: Actor, path: string, data: object) {
  const response = await request.post(`${api}${path}`, { headers: auth(user), data });
  expect(response.status()).toBe(201);
  return response.json();
}

async function login(page: Page, user: Actor) {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Included backend', exact: true }).click();
  await page.getByLabel('Server URL', { exact: true }).filter({ visible: true }).fill(api);
  await page.getByLabel('Handle', { exact: true }).fill(user.name);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New message', exact: true })).toBeVisible();
}

function validPng() {
  const chunk = (name: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(name), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(content));
    return Buffer.concat([size, content, checksum]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
    chunk('IDAT', deflateSync(Buffer.from([0, 240, 80, 80, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('real CORS login, private photo, older history, receipts and keyed text send', async ({ page, request }) => {
  const alice = await actor(request, 'alice');
  const bob = await actor(request, 'bob');
  const marker = randomUUID().slice(0, 8);
  const room = await post(request, bob, '/conversation', { type: 'GROUP', name: `History ${marker}`, participants_ids: [alice.id] });
  await post(request, bob, '/conversation', { type: 'DM', participants_ids: [alice.id] });
  for (let index = 1; index <= 25; index++) {
    await post(request, bob, '/message', { conversation_id: room.id, content: `${marker} history ${String(index).padStart(2, '0')}` });
  }
  const file = await post(request, bob, '/file', { file_name: 'fixture.png', mime_type: 'image/png', data: validPng().toString('base64') });
  const photo = await post(request, bob, '/message', { conversation_id: room.id, content: `${marker} photo`, file_id: file.id });

  // This success case has no route interception or CORS/HTML test shim.
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (/Unexpected text node|must be rendered within a <Text>/.test(message.text())) pageErrors.push(message.text());
  });
  await login(page, alice);
  await expect(page.getByRole('button', { name: `Open ${bob.name}`, exact: true })).toBeVisible();
  const downloaded = page.waitForResponse(response => response.url() === `${api}/file/${file.id}/download` && response.status() === 200);
  await page.getByRole('button', { name: `Open ${room.name}`, exact: true }).click();
  const binary = await downloaded;
  expect((await binary.request().allHeaders()).authorization).toBe(auth(alice).Authorization);
  expect((await binary.body()).length).toBe(validPng().length);
  await expect.poll(() => page.evaluate(async () => {
    const source = Array.from(document.querySelectorAll<HTMLElement>('*'))
      .map(element => element instanceof HTMLImageElement ? element.src : element.style.backgroundImage)
      .find(value => value.includes('blob:'));
    const url = source?.match(/blob:[^"')]+/)?.[0];
    if (!url) return false;
    return new Promise<boolean>(resolve => {
      const image = new Image();
      image.onload = () => resolve(image.naturalWidth > 0);
      image.onerror = () => resolve(false);
      image.src = url;
    });
  })).toBe(true);

  await expect.poll(async () => {
    const response = await request.get(`${api}/message?conversation_id=${room.id}`, { headers: auth(bob) });
    const body = await response.json();
    return body.data.find((message: { id: string }) => message.id === photo.id)?.status[alice.id]?.delivered;
  }).toBe(true);
  await page.getByLabel('Load older messages', { exact: true }).click();
  await expect(page.getByText(`${marker} history 01`, { exact: true })).toBeAttached();

  const sentResponse = page.waitForResponse(response => response.url() === `${api}/message` && response.request().method() === 'POST');
  await page.getByLabel('Message', { exact: true }).fill(`${marker} web send`);
  await page.getByLabel('Send message', { exact: true }).click();
  const sent = await sentResponse;
  expect(sent.status()).toBe(201);
  const payload = sent.request().postDataJSON();
  expect(payload.client_message_id).toMatch(/^[0-9a-f-]{36}$/i);
  const original = await sent.json();
  const replay = await post(request, alice, '/message', payload);
  expect(replay.id).toBe(original.id);
  await expect(page.getByText(`${marker} web send`, { exact: true }).filter({ visible: true })).toHaveCount(1);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a lost successful response can be retried without a duplicate message', async ({ page, request }) => {
  const alice = await actor(request, 'retry');
  const bob = await actor(request, 'peer');
  const room = await post(request, alice, '/conversation', { type: 'DM', participants_ids: [bob.id] });
  await login(page, alice);
  await page.getByRole('button', { name: `Open ${bob.name}`, exact: true }).click();
  let committedId = '';
  let loseResponse = true;
  await page.route(`${api}/message`, async route => {
    if (route.request().method() !== 'POST' || !loseResponse) return route.continue();
    loseResponse = false;
    const response = await route.fetch();
    committedId = (await response.json()).id;
    await route.abort('failed');
  });
  const text = `Uncertain ${randomUUID().slice(0, 8)}`;
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByLabel('Send message', { exact: true }).click();
  await page.getByLabel('Retry sending this message', { exact: true }).click();
  await expect.poll(async () => {
    const response = await request.get(`${api}/message?conversation_id=${room.id}`, { headers: auth(alice) });
    const body = await response.json();
    return body.data.filter((message: { content: string }) => message.content === text).map((message: { id: string }) => message.id);
  }).toEqual([committedId]);
  await expect(page.getByLabel('Retry sending this message', { exact: true })).toHaveCount(0);
});

test('new-chat errors are visible and successful DMs identify the peer', async ({ page, request }) => {
  const alice = await actor(request, 'create');
  const bob = await actor(request, 'contact');
  await login(page, alice);
  await page.getByRole('button', { name: 'New message', exact: true }).click();
  await page.getByLabel('Search contacts', { exact: true }).fill(bob.name);
  // Only this deliberate failure is intercepted; it is not a connectivity bypass.
  await page.route(`${api}/conversation`, route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:8081' },
    body: JSON.stringify({ message: 'Deliberate test outage' }),
  }), { times: 1 });
  await page.getByLabel(`Message ${bob.name}`, { exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Deliberate test outage');
  await page.getByLabel(`Message ${bob.name}`, { exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await expect(page.getByText(bob.name, { exact: true }).filter({ visible: true }).first()).toBeVisible();
});

test('server switching clears identity and credentials while appearance and server choice persist', async ({ page, request }) => {
  const user = await actor(request, 'settings');
  await login(page, user);
  await page.getByText('Settings', { exact: true }).filter({ visible: true }).last().click();
  await expect(page.getByText(`ID: ${user.id}`, { exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByText('Dark', { exact: true }).filter({ visible: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('@chat-app/appearance'))).toBe('dark');
  const target = new URL(api);
  target.hostname = target.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  const changedServer = target.toString().replace(/\/+$/, '');
  const leakedCredentials: string[] = [];
  page.on('request', request => {
    if (request.url().startsWith(changedServer) && request.headers().authorization) leakedCredentials.push(request.url());
  });
  await page.getByLabel('Server URL', { exact: true }).filter({ visible: true }).fill(changedServer);
  await page.getByRole('button', { name: 'Apply Server', exact: true }).click();
  await expect(page.getByText(`ID: ${user.id}`, { exact: true }).filter({ visible: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in(?:[?#]|$)/);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  const expectSelectedServer = async () => {
    const fields = page.getByLabel('Server URL', { exact: true }).filter({ visible: true });
    expect(await fields.count()).toBeGreaterThan(0);
    for (const field of await fields.all()) await expect(field).toHaveValue(changedServer);
  };
  await expectSelectedServer();
  await page.reload();
  // Router may restore the public Settings tab while the session is signed out.
  const signIn = page.getByRole('button', { name: 'Sign In', exact: true });
  if (await signIn.isVisible()) await signIn.click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expectSelectedServer();
  expect(await page.evaluate(password => Object.values(localStorage).some(value => value.includes(password)), user.password)).toBe(false);
  expect(leakedCredentials).toEqual([]);
});
