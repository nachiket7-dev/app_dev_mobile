import { apiFetch, type RequestOptions } from './config.ts';
import type { BackendCapabilities, BackendMode } from './types';
import { parseCapabilities, parseUser } from './validation.ts';

export const LEGACY_CAPABILITIES: BackendCapabilities = { idempotency: false, receipts: false, conversationSummary: false };

export async function getServerCapabilities(options: RequestOptions): Promise<BackendCapabilities> {
  return parseCapabilities(await apiFetch('/health', { ...options, authenticated: false }));
}

/** Tests the edited URL without mutating the active config or transmitting credentials. */
export async function testServerConnection(baseUrl: string, mode: BackendMode, signal?: AbortSignal): Promise<string> {
  const options = { config: { baseUrl, username: '', password: '' }, authenticated: false, signal };
  if (mode === 'included') {
    const capabilities = await getServerCapabilities(options);
    return `Included backend is ready. Receipts ${capabilities.receipts ? 'available' : 'unavailable'}. No credentials were sent.`;
  }
  try {
    parseUser(await apiFetch('/user/profile', options));
    return 'Legacy API responded. This tests reachability only; no credentials were sent.';
  } catch (error) {
    if ((error as { status?: number }).status === 401) {
      return 'Legacy sign-in endpoint is reachable. Sign in to validate credentials. No credentials were sent.';
    }
    throw error;
  }
}
