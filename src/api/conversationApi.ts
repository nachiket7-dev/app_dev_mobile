import { apiFetch, type RequestOptions } from './config.ts';
import type { Conversation, CreateConversationPayload } from './types';
import { parseConversation, parseConversations } from './validation.ts';

export const conversationApi = {
  /**
   * Fetch all conversations the authenticated user is a participant in,
   * sorted newest first.
   * GET /conversation
   */
  async getConversations(options?: RequestOptions): Promise<Conversation[]> {
    return parseConversations(await apiFetch('/conversation', options));
  },

  /**
   * Create a new conversation (DM or GROUP) or retrieve existing DM.
   * Sanitizes payload keys to strictly match NestJS whitelisted DTO properties:
   * `participants_ids` for both DMs and groups.
   * POST /conversation
   */
  async createConversation(payload: CreateConversationPayload, options?: RequestOptions): Promise<Conversation> {
    const body: Record<string, unknown> = {};
    if (payload.type) body.type = payload.type;
    if (payload.name) body.name = payload.name;

    // Normalizes recipient into participants_ids (backend only accepts participants_ids)
    const recipient = payload.recipient_id;
    const participants = payload.participants_ids || [];

    const allParticipants = Array.isArray(participants) ? [...participants] : [];
    if (recipient && !allParticipants.includes(recipient)) {
      allParticipants.push(recipient);
    }

    if (allParticipants.length > 0) {
      body.participants_ids = allParticipants;
    }

    return parseConversation(await apiFetch('/conversation', {
      ...options,
      method: 'POST',
      body: JSON.stringify(body),
    }));
  },

  /**
   * Helper to start or open a direct message with a user.
   */
  async startDirectMessage(recipientId: string): Promise<Conversation> {
    return conversationApi.createConversation({
      type: 'DM',
      recipient_id: recipientId,
    });
  },

  /**
   * Helper to create a group conversation.
   */
  async createGroup(name: string, participantIds: string[]): Promise<Conversation> {
    return conversationApi.createConversation({
      type: 'GROUP',
      name,
      participants_ids: participantIds,
    });
  },
};
