import type { ApiConfig } from './types';

export const DEFAULT_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';

let sessionController = new AbortController();

let currentConfig: ApiConfig = {
  baseUrl: DEFAULT_BASE_URL,
  username: '',
  password: '',
  signal: sessionController.signal,
};

export function setApiConfig(config: Partial<ApiConfig>) {
  const baseUrl = config.baseUrl?.replace(/\/+$/, '') || currentConfig.baseUrl;
  const changedServer = baseUrl !== currentConfig.baseUrl;
  const username = config.username ?? (changedServer ? '' : currentConfig.username);
  const password = config.password ?? (changedServer ? '' : currentConfig.password);
  if (changedServer || username !== currentConfig.username || password !== currentConfig.password ||
      config.sessionKey !== undefined && config.sessionKey !== currentConfig.sessionKey) {
    sessionController.abort();
    sessionController = new AbortController();
  }
  currentConfig = {
    ...currentConfig,
    ...config,
    baseUrl,
    username,
    password,
    signal: sessionController.signal,
  };
}

export function getApiConfig(): ApiConfig {
  return currentConfig;
}

/**
 * Returns the exact Authorization header expected by the NestJS AuthGuard:
 * `Basic <username>:<password>` (plain text, NOT base64).
 */
export function getAuthHeader(config: ApiConfig = currentConfig): string | null {
  if (!config.username || !config.password) {
    return null;
  }
  return `Basic ${config.username}:${config.password}`;
}

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  config?: ApiConfig;
  authenticated?: boolean;
  responseType?: 'json' | 'image';
}

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export function abortError() {
  const error = new Error('Request cancelled because the session or screen changed.');
  error.name = 'AbortError';
  return error;
}

/**
 * Core HTTP client for the Chat App backend.
 * Handles authentication header injection, timeout, and NestJS error formatting.
 */
export async function apiFetch<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const { config = getApiConfig(), authenticated = true, timeoutMs = 10000, responseType = 'json', signal, ...request } = options;
  const { baseUrl } = config;
  const url = `${baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  const supplied = new Headers(options.headers);
  // Authorization always comes from this captured session, never caller/global headers.
  supplied.delete('authorization');
  const headers: Record<string, string> = Object.fromEntries(supplied.entries());
  if (!supplied.has('accept')) headers.Accept = responseType === 'image' ? 'image/*' : 'application/json';
  if (options.body && !supplied.has('content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  const authHeader = authenticated ? getAuthHeader(config) : null;
  if (authHeader) {
    headers['Authorization'] = authHeader;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  const signals = [signal, config.signal].filter((value): value is AbortSignal => !!value);
  signals.forEach((value) => value.addEventListener('abort', abort, { once: true }));
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

  try {
    if (signals.some((value) => value.aborted)) throw abortError();
    const response = await fetch(url, {
      ...request,
      headers,
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
    if (controller.signal.aborted) throw abortError();

    if (responseType === 'image' && response.ok) {
      const mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
      if (!/^image\/(jpeg|png|gif|webp|bmp|avif|heic|heif)$/.test(mimeType)) {
        controller.abort();
        throw new Error('The server did not return a supported photo.');
      }
      if (Number(response.headers.get('content-length')) > MAX_PHOTO_BYTES) {
        controller.abort();
        throw new Error('Photo exceeds the 10 MB display limit.');
      }
      const reader = response.body?.getReader();
      let blob: Blob;
      if (reader) {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (controller.signal.aborted) throw abortError();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_PHOTO_BYTES) throw new Error('Photo exceeds the 10 MB display limit.');
            chunks.push(new Uint8Array(value));
          }
          blob = new Blob(chunks, { type: mimeType });
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
      } else {
        blob = await response.blob();
      }
      if (controller.signal.aborted) throw abortError();
      if (!blob.size || blob.size > MAX_PHOTO_BYTES) throw new Error('Photo is empty or exceeds the 10 MB display limit.');
      return blob as T;
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    const contentType = response.headers.get('content-type');
    const isJson = contentType && contentType.includes('application/json');
    const responseData = isJson ? await response.json() : null;
    if (controller.signal.aborted) throw abortError();

    if (!response.ok) {
      if (!isJson) controller.abort();
      const errorMessage =
        typeof responseData === 'object' && responseData !== null
          ? Array.isArray(responseData.message)
            ? responseData.message.join(', ')
            : responseData.message || responseData.error || `HTTP ${response.status}`
          : `HTTP ${response.status}. The server did not return a chat API response.`;

      const error = new Error(errorMessage);
      (error as any).status = response.status;
      (error as any).data = responseData;
      throw error;
    }

    if (!isJson) {
      controller.abort();
      throw new Error('The server returned a non-JSON response. Check that the URL points to the chat API, not a web page.');
    }

    return responseData as T;
  } catch (error: any) {
    if (error.name === 'AbortError' && timedOut) {
      throw new Error(
        `Connection timed out. Could not reach ${url}. Please verify your device is connected to the same Wi-Fi/network and the server is running.`
      );
    }
    if (
      error.message === 'Failed to fetch' ||
      error.message === 'Network request failed' ||
      error.message?.includes('NetworkError')
    ) {
      throw new Error(
        `Cannot connect to server at ${baseUrl}. Please check that the backend is running and reachable.`
      );
    }
    throw error;
  } finally {
    // Keep the timeout active while reading the body, not only until headers arrive.
    clearTimeout(timeoutId);
    signals.forEach((value) => value.removeEventListener('abort', abort));
  }
}
