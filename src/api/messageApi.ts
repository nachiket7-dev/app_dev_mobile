import { apiFetch, getApiConfig, type RequestOptions } from './config.ts';
import type {
  CreateMessagePayload,
  GetMessagesParams,
  Message,
  PaginatedMessagesResponse,
  AcknowledgeMessagesPayload,
} from './types';
import { parseMessage, parseMessagePage } from './validation.ts';
import { sessionMediaReadQueue } from '../utils/mediaReadQueue.ts';

export const messageApi = {
  /**
   * Fetch messages for a conversation with cursor pagination.
   * First page: omit `from_message_cursor`.
   * Subsequent pages: pass `nextCursor` from the previous response.
   * Returns data in chronological (oldest-first) order.
   * GET /message?conversation_id=...&from_message_cursor=...
   */
  async getMessages(params: GetMessagesParams, options?: RequestOptions): Promise<PaginatedMessagesResponse> {
    const searchParams = new URLSearchParams();
    searchParams.append('conversation_id', params.conversation_id);
    if (params.from_message_cursor) {
      searchParams.append('from_message_cursor', params.from_message_cursor);
    }

    const config = options?.config || getApiConfig();
    const release = await sessionMediaReadQueue(config).acquire([config.signal, options?.signal]);
    try {
      return parseMessagePage(await apiFetch(`/message?${searchParams.toString()}`, { ...options, config }), params.conversation_id);
    } finally { release(); }
  },

  /**
   * Send a new message to a conversation.
   * POST /message
   */
  async sendMessage(payload: CreateMessagePayload, options?: RequestOptions): Promise<Message> {
    const config = options?.config || getApiConfig();
    const { client_message_id, file_id, ...original } = payload;
    if (config.backendMode === 'legacy' && file_id && !original.imageInfo) {
      throw new Error('Legacy mode uses inline photos. Reselect the photo instead of sending a stored file ID.');
    }
    const legacyPayload = { ...original, ...(config.backendMode !== 'legacy' && file_id ? { file_id } : {}) };
    const body = config.backendMode === 'included' && config.capabilities?.idempotency && client_message_id
      ? { ...legacyPayload, client_message_id } : legacyPayload;
    return parseMessage(await apiFetch('/message', {
      ...options,
      config,
      method: 'POST',
      body: JSON.stringify(body),
    }), payload.conversation_id);
  },

  async acknowledge(payload: AcknowledgeMessagesPayload, options?: RequestOptions): Promise<void> {
    const config = options?.config || getApiConfig();
    if (config.backendMode !== 'included' || !config.capabilities?.receipts) return;
    if (!payload.message_ids.length || payload.message_ids.length > 100) throw new Error('Receipt batches must contain 1 to 100 messages.');
    const result = await apiFetch<{ status: string; acknowledged?: number }>('/message/acknowledge', { ...options, config, method: 'POST', body: JSON.stringify(payload) });
    if (!result || result.status !== 'ok' || result.acknowledged !== undefined && result.acknowledged !== new Set(payload.message_ids).size) {
      throw new Error('The server did not confirm this receipt batch. Messages have been kept.');
    }
  },
};
