import type { BackendCapabilities, Conversation, FileMetadata, Message, PaginatedMessagesResponse, User } from './types';

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label} response. Check that the server URL points to the chat API.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label} in the API response.`);
  return value;
}

function date(value: unknown, label: string): string {
  const result = text(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Invalid ${label} in the API response.`);
  return result;
}

function optionalText(value: unknown, label: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw new Error(`Invalid ${label} in the API response.`);
  return value;
}

export function parseUser(value: unknown): User {
  const user = record(value, 'profile');
  // Only canonical public fields may enter the session or user cache.
  return { id: text(user.id, 'user ID'), name: text(user.name, 'user name'), bio: optionalText(user.bio, 'bio') };
}

export function parseUsers(value: unknown): User[] {
  if (!Array.isArray(value)) throw new Error('Invalid contacts response from the chat API.');
  return value.map(parseUser);
}

export function parseConversation(value: unknown): Conversation {
  const conversation = record(value, 'conversation');
  if (conversation.type !== 'DM' && conversation.type !== 'GROUP') throw new Error('Invalid conversation type.');
  if (!Array.isArray(conversation.participants_ids) || !conversation.participants_ids.length) {
    throw new Error('Invalid conversation participants.');
  }
  if (conversation.unreadCount !== undefined &&
      (!Number.isSafeInteger(conversation.unreadCount) || (conversation.unreadCount as number) < 0)) {
    throw new Error('Invalid conversation unread count.');
  }
  return {
    id: text(conversation.id, 'conversation ID'),
    type: conversation.type,
    name: optionalText(conversation.name, 'conversation name'),
    createdAt: date(conversation.createdAt, 'conversation date'),
    createdBy: text(conversation.createdBy, 'conversation creator'),
    participants_ids: [...new Set(conversation.participants_ids.map((id) => text(id, 'participant ID')))],
    lastMessageAt: conversation.lastMessageAt == null ? conversation.lastMessageAt as null | undefined : date(conversation.lastMessageAt, 'last message date'),
    lastMessagePreview: optionalText(conversation.lastMessagePreview, 'last message preview'),
    unreadCount: conversation.unreadCount as number | undefined,
  };
}

export function parseConversations(value: unknown): Conversation[] {
  if (!Array.isArray(value)) throw new Error('Invalid conversations response from the chat API.');
  return value.map(parseConversation);
}

export function parseFile(value: unknown): FileMetadata {
  const file = record(value, 'file');
  if (file.kind !== 'IMAGE' && file.kind !== 'FILE') throw new Error('Invalid attachment kind.');
  if (typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Invalid attachment size.');
  return {
    id: text(file.id, 'file ID'), name: text(file.name, 'file name'), mimeType: text(file.mimeType, 'file MIME type'),
    size: file.size, kind: file.kind, uploadedBy: text(file.uploadedBy, 'file owner'),
    createdAt: date(file.createdAt, 'file date'), downloadUrl: text(file.downloadUrl, 'file download path'),
  };
}

export function parseMessage(value: unknown, conversationId?: string): Message {
  const message = record(value, 'message');
  if (message.type !== undefined && !['TEXT', 'IMAGE', 'FILE'].includes(message.type as string)) throw new Error('Invalid message type.');
  const status: Message['status'] = {};
  if (message.status != null) {
    for (const [id, value] of Object.entries(record(message.status, 'message status'))) {
      const receipt = record(value, 'message receipt');
      if (typeof receipt.delivered !== 'boolean' || typeof receipt.read !== 'boolean') throw new Error('Invalid message receipt.');
      status[id] = { delivered: receipt.delivered, read: receipt.read };
    }
  }
  const result: Message = {
    id: text(message.id, 'message ID'), conversationId: text(message.conversationId, 'message conversation'),
    senderId: text(message.senderId, 'message sender'), createdAt: date(message.createdAt, 'message date'),
    content: optionalText(message.content, 'message text'), imageInfo: optionalText(message.imageInfo, 'legacy image'),
    fileId: optionalText(message.fileId, 'attachment ID'), file: message.file == null ? undefined : parseFile(message.file),
    type: message.type as Message['type'], status,
  };
  if (message.clientMessageId != null) result.clientMessageId = text(message.clientMessageId, 'client message ID');
  if (conversationId && result.conversationId !== conversationId) throw new Error('The API returned a message from a different conversation.');
  return result;
}

export function parseMessagePage(value: unknown, conversationId: string): PaginatedMessagesResponse {
  const page = record(value, 'message history');
  if (!Array.isArray(page.data) || !Number.isSafeInteger(page.count) || (page.count as number) < 0) {
    throw new Error('Invalid message history response.');
  }
  return {
    data: page.data.map((message) => parseMessage(message, conversationId)),
    count: page.count as number,
    nextCursor: optionalText(page.nextCursor, 'history cursor') || null,
  };
}

export function parseCapabilities(value: unknown): BackendCapabilities {
  const health = record(value, 'health');
  if (health.status !== 'ok') throw new Error('The included backend is not ready.');
  const capabilities = record(health.capabilities, 'backend capabilities');
  for (const key of ['idempotency', 'receipts', 'conversationSummary']) {
    if (typeof capabilities[key] !== 'boolean') throw new Error('This server does not advertise the included backend contract. Use external legacy mode if appropriate.');
  }
  return {
    idempotency: capabilities.idempotency as boolean,
    receipts: capabilities.receipts as boolean,
    conversationSummary: capabilities.conversationSummary as boolean,
  };
}
