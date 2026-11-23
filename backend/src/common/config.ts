import { isIP } from 'node:net';

export function boundedInteger(
  name: string,
  fallback: number,
  min: number,
  max: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boolean(name: string, fallback: boolean, env: NodeJS.ProcessEnv) {
  if (env[name] === undefined || env[name] === '') return fallback;
  if (env[name] !== 'true' && env[name] !== 'false') {
    throw new Error(`${name} must be true or false`);
  }
  return env[name] === 'true';
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test or production');
  }
  const allowLocalHttp = boolean('ALLOW_INSECURE_LOCAL_HTTP', false, env);
  if (nodeEnv === 'production' && allowLocalHttp) {
    throw new Error('Production requires HTTPS; local HTTP cannot be enabled');
  }
  const bindHost = env.BIND_HOST ?? '127.0.0.1';
  if (!isIP(bindHost) && bindHost !== 'localhost') {
    throw new Error('BIND_HOST must be an IP address or localhost');
  }
  const corsOrigins = (env.CORS_ORIGINS ?? 'http://localhost:8081,http://127.0.0.1:8081')
    .split(',').map((origin) => origin.trim()).filter(Boolean);
  if (corsOrigins.length > 32 || (env.CORS_ORIGINS?.length ?? 0) > 8192) throw new Error('CORS_ORIGINS is limited to 32 origins and 8192 characters');
  for (const origin of corsOrigins) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error('CORS_ORIGINS must contain exact HTTP(S) origins'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error('CORS_ORIGINS must contain exact HTTP(S) origins, never wildcards');
    }
  }
  return {
    nodeEnv, allowLocalHttp, bindHost, corsOrigins,
    port: boundedInteger('PORT', 3000, 1, 65535, env),
    trustProxyHops: boundedInteger('TRUST_PROXY_HOPS', 0, 0, 2, env),
    maxUploadMb: boundedInteger('MAX_UPLOAD_MB', 10, 1, 12, env),
    maxInlineImageMb: boundedInteger('MAX_INLINE_IMAGE_MB', 2, 1, 4, env),
    maxImagePixels: boundedInteger('MAX_IMAGE_PIXELS', 16_000_000, 1_000_000, 24_000_000, env),
    remoteFetchTimeoutMs: boundedInteger('REMOTE_FETCH_TIMEOUT_MS', 15_000, 1000, 30_000, env),
    maxConcurrentRequests: boundedInteger('MAX_CONCURRENT_REQUESTS', 64, 8, 128, env),
    maxConcurrentUploads: boundedInteger('MAX_CONCURRENT_UPLOADS', 8, 1, 16, env),
    maxConcurrentMediaReads: boundedInteger('MAX_CONCURRENT_MEDIA_READS', 2, 1, 8, env),
    requestsPerMinute: boundedInteger('REQUESTS_PER_MINUTE', 300, 30, 3000, env),
    botMode: boolean('BOT_MODE', false, env),
    botIntervalMs: boundedInteger('BOT_INTERVAL_MS', 30_000, 10_000, 300_000, env),
    botBatchSize: boundedInteger('BOT_BATCH_SIZE', 10, 1, 50, env),
  };
}

export const CONFIG = readConfig();
