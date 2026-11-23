require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Prisma } = require('@prisma/client');
const { Reflector } = require('@nestjs/core');
const { AuthGuard } = require('../src/auth/auth.guard');
const { PUBLIC_ROUTE } = require('../src/auth/public.decorator');
const { hashPassword, verifyPassword } = require('../src/auth/password');

const ID = '64b8f9e2c4a3b12d4e5f6789';
function context(header, handler = () => {}) {
  const request = { headers: { authorization: header } };
  return { request, switchToHttp: () => ({ getRequest: () => request }), getHandler: () => handler, getClass: () => AuthGuard };
}
function collision() {
  return new Prisma.PrismaClientKnownRequestError('unique collision', { code: 'P2002', clientVersion: '6.19.3' });
}

test('scrypt hashes are independently salted and fail closed', async () => {
  const first = await hashPassword('disposable-secret');
  const second = await hashPassword('disposable-secret');
  assert.notEqual(first, second);
  assert.ok(!first.includes('disposable-secret'));
  assert.equal(await verifyPassword('disposable-secret', first), true);
  for (const value of [null, undefined, '', 'disposable-secret', 'scrypt$v1$999999999$8$1$bad']) {
    assert.equal(await verifyPassword('disposable-secret', value), false);
  }
  assert.equal(await verifyPassword('wrong', first), false);
  assert.equal(await verifyPassword('', first), false);
});

test('missing, empty, base64 Basic and reserved bot credentials never reach registration', async () => {
  let calls = 0;
  const guard = new AuthGuard({ user: { findUnique: () => { calls++; } } }, new Reflector());
  for (const header of [undefined, 'Bearer token', 'Basic ', 'Basic :pass', 'Basic user:', 'Basic user:   ',
    `Basic ${Buffer.from('user:pass').toString('base64')}`, 'Basic FactBot:password', 'Basic factbot:password', 'Basic FactBot\u200b:password',
    'Basic user\u001b[31m:password', `Basic user:${'x'.repeat(1025)}`]) {
    await assert.rejects(guard.canActivate(context(header)), (error) => error.getStatus() === 401);
  }
  assert.equal(calls, 0);
});

test('public health-style handlers ignore auth without auto-registration', async () => {
  const handler = () => {};
  Reflect.defineMetadata(PUBLIC_ROUTE, true, handler);
  const guard = new AuthGuard({ user: { findUnique: () => { throw new Error('must not access users'); } } }, new Reflector());
  const request = context('Basic health_probe:password', handler);
  assert.equal(await guard.canActivate(request), true);
  assert.equal(request.request.user, undefined);
});

test('legacy plaintext and missing hashes cannot authenticate', async () => {
  const guard = new AuthGuard({ user: { findUnique: async () => ({ id: ID, name: 'legacy', phone: 'pass', passwordHash: null, isBot: false }) } }, new Reflector());
  await assert.rejects(guard.canActivate(context('Basic legacy:pass')), (error) => error.getStatus() === 401);
});

test('eight equal first-use logins all resolve one account and expose no hash', async () => {
  let stored;
  let creations = 0;
  const prisma = { user: {
    findUnique: async () => { await new Promise(setImmediate); return stored ?? null; },
    create: async ({ data }) => {
      if (stored) throw collision();
      creations++;
      stored = { ...data, id: ID, bio: null };
      return stored;
    },
  } };
  const guard = new AuthGuard(prisma, new Reflector());
  const requests = Array.from({ length: 8 }, () => context('Basic first_user:disposable-pass'));
  assert.deepEqual(await Promise.all(requests.map((request) => guard.canActivate(request))), Array(8).fill(true));
  assert.equal(creations, 1);
  assert.equal(new Set(requests.map((request) => request.request.user.id)).size, 1);
  assert.equal(stored.phone, undefined);
  assert.ok(stored.passwordHash.startsWith('scrypt$'));
  assert.equal(requests[0].request.user.passwordHash, undefined);
});

test('different concurrent passwords cannot claim the winning account', async () => {
  let stored;
  const guard = new AuthGuard({ user: {
    findUnique: async () => { await new Promise(setImmediate); return stored ?? null; },
    create: async ({ data }) => {
      if (stored) throw collision();
      stored = { ...data, id: ID, bio: null };
      return stored;
    },
  } }, new Reflector());
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => guard.canActivate(context(`Basic race_user:password-${index}`))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter((result) => result.status === 'rejected').every((result) => result.reason.getStatus() === 401));
});
