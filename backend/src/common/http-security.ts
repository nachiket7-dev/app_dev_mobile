import { ArgumentsHost, CallHandler, Catch, ExceptionFilter, ExecutionContext, HttpException, Logger, NestInterceptor } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { CONFIG } from './config';
import { JSON_BODY_LIMIT } from './base64.util';
import { finalize } from 'rxjs';

const LIFETIME = Symbol('requestLifetime');
type BoundedRequest = Request & { [LIFETIME]?: { started: boolean; completed: boolean; release: () => void } };

export function markRequestProcessing(request: BoundedRequest) {
  if (request[LIFETIME]) request[LIFETIME].started = true;
}

export class RequestLifetimeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<BoundedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(finalize(() => {
      const lifetime = request[LIFETIME];
      if (lifetime) {
        lifetime.completed = true;
        if (response.destroyed || response.writableFinished) lifetime.release();
      }
    }));
  }
}

export function isLocalHttpHostname(host: string) {
  if (typeof host !== 'string') return false;
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (value === 'localhost' || value === '::1') return true;
  const parts = value.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (parts[0] === 127 || parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168));
}

export function requestBounds(maxBodyBytes = 32 * 1024 * 1024) {
  let inFlight = 0;
  let uploads = 0;
  let mediaReads = 0;
  let bodyBytes = 0;
  let prunedAt = Date.now();
  const windows = new Map<string, { startedAt: number; count: number }>();
  return (request: BoundedRequest, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const health = request.method === 'GET' && request.path === '/health';
    if (!health && !request.secure && !(CONFIG.allowLocalHttp && isLocalHttpHostname(request.hostname))) {
      response.status(403).json({ statusCode: 403, message: 'HTTPS is required; HTTP is only permitted for explicit local test development' });
      return;
    }
    const encoding = String(request.headers?.['content-encoding'] ?? 'identity').toLowerCase().trim();
    if (!['identity', 'gzip', 'deflate', 'br'].includes(encoding)) {
      response.status(415).json({ statusCode: 415, message: 'Unsupported request content encoding' });
      return;
    }
    const length = request.headers?.['content-length'];
    const hasBody = length !== undefined || !!request.headers?.['transfer-encoding'] || ['POST', 'PUT', 'PATCH'].includes(request.method);
    const wireBytes = length === undefined ? JSON_BODY_LIMIT : Number(length);
    const reservedBytes = !hasBody ? 0 : encoding !== 'identity' ? JSON_BODY_LIMIT : wireBytes;
    if (!Number.isSafeInteger(wireBytes) || wireBytes < 0 || wireBytes > JSON_BODY_LIMIT) {
      response.setHeader('Connection', 'close');
      response.status(413).json({ statusCode: 413, message: 'Request body is too large' });
      return;
    }
    const now = Date.now();
    if (now - prunedAt >= 60_000) {
      for (const [ip, window] of windows) if (now - window.startedAt >= 60_000) windows.delete(ip);
      prunedAt = now;
    }
    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const previous = windows.get(ip);
    if (!previous && windows.size >= 4096) {
      response.status(429).json({ statusCode: 429, message: 'Request capacity exceeded; retry later' });
      return;
    }
    const window = previous && now - previous.startedAt < 60_000 ? previous : { startedAt: now, count: 0 };
    window.count++;
    windows.set(ip, window);
    const upload = request.method === 'POST' && /^\/(file|message)(\/|$)/.test(request.path);
    const mediaRead = request.method === 'GET' && /^\/(file|message)(\/|$)/.test(request.path);
    if (window.count > CONFIG.requestsPerMinute || inFlight >= CONFIG.maxConcurrentRequests ||
        (upload && uploads >= CONFIG.maxConcurrentUploads) || (mediaRead && mediaReads >= CONFIG.maxConcurrentMediaReads) ||
        bodyBytes + reservedBytes > maxBodyBytes) {
      response.setHeader('Retry-After', '1');
      response.setHeader('Connection', 'close');
      response.status(429).json({ statusCode: 429, message: 'Request limit exceeded; retry later' });
      return;
    }
    inFlight++;
    if (upload) uploads++;
    if (mediaRead) mediaReads++;
    bodyBytes += reservedBytes;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight--;
      if (upload) uploads--;
      if (mediaRead) mediaReads--;
      bodyBytes -= reservedBytes;
    };
    request[LIFETIME] = { started: false, completed: false, release };
    response.once('finish', release);
    response.once('close', () => {
      // Keep work counted after a disconnected client while auth/decoding/DB work still runs.
      if (!request[LIFETIME].started || request[LIFETIME].completed) release();
    });
    next();
  };
}

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(error: unknown, host: ArgumentsHost) {
    host.switchToHttp().getRequest<BoundedRequest>()[LIFETIME]?.release();
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    if (error instanceof HttpException) {
      const body = error.getResponse();
      response.status(error.getStatus()).json(typeof body === 'string' ? { statusCode: error.getStatus(), message: body } : body);
      return;
    }
    const type = (error as { type?: string })?.type;
    const code = (error as { code?: string })?.code;
    if (type === 'entity.too.large' || type === 'entity.parse.failed' || (typeof code === 'string' && code.startsWith('Z_'))) {
      const code = type === 'entity.too.large' ? 413 : 400;
      response.status(code).json({ statusCode: code, message: code === 413 ? 'Request body is too large' : 'Malformed JSON body' });
      return;
    }
    // Prisma/HTTP errors can contain credentials, message bodies and user-controlled text.
    this.logger.error('Unhandled request failure; sensitive error details suppressed');
    response.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}
