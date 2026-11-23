import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const PREFIX = 'scrypt$v1$16384$8$1$';
const HASH = /^scrypt\$v1\$16384\$8\$1\$([0-9a-f]{32})\$([0-9a-f]{128})$/;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

export function isPasswordHash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${PREFIX}${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: unknown) {
  if (!password || !isPasswordHash(stored)) return false;
  const match = HASH.exec(stored)!;
  try {
    const key = await derive(password, Buffer.from(match[1], 'hex'));
    return timingSafeEqual(key, Buffer.from(match[2], 'hex'));
  } catch { return false; }
}
