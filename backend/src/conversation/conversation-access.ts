import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { canonicalDmKey, normalizeObjectId } from '../common/input.util';

export const CONVERSATION_SELECT = {
  id: true, name: true, type: true, createdAt: true, createdBy: true,
  participants_ids: true, conversationKey: true, activityAt: true,
  lastMessageAt: true, lastMessageId: true, lastMessagePreview: true, unreadCounts: true,
} as const;

type Conversation = Prisma.ConversationGetPayload<{ select: typeof CONVERSATION_SELECT }>;

export function assertCanonicalConversation(conversation: Conversation) {
  const ids = conversation.participants_ids;
  if (ids.length < 2 || new Set(ids).size !== ids.length || !ids.includes(conversation.createdBy) ||
      (conversation.type === 'DM' && (ids.length !== 2 || conversation.conversationKey !== canonicalDmKey(ids))) ||
      (conversation.type === 'GROUP' && !/^group:[0-9a-f-]{36}$/i.test(conversation.conversationKey)) ||
      !['DM', 'GROUP'].includes(conversation.type)) {
    throw new ConflictException('Legacy conversation requires reviewed migration');
  }
}

export async function requireConversationMember(
  client: Pick<Prisma.TransactionClient, 'conversation'>,
  conversationId: string,
  callerId: string,
) {
  const conversation = await client.conversation.findUnique({
    where: { id: normalizeObjectId(conversationId) }, select: CONVERSATION_SELECT,
  });
  if (!conversation) throw new NotFoundException('Conversation not found');
  if (!conversation.participants_ids.includes(normalizeObjectId(callerId))) {
    throw new ForbiddenException('You are not a participant of this conversation');
  }
  assertCanonicalConversation(conversation);
  return conversation;
}

export function conversationResponse(conversation: Conversation, callerId: string) {
  const counts = conversation.unreadCounts as Record<string, unknown> | null;
  const count = counts?.[callerId];
  return {
    id: conversation.id, name: conversation.name, type: conversation.type,
    createdAt: conversation.createdAt, createdBy: conversation.createdBy,
    participants_ids: conversation.participants_ids,
    lastMessageAt: conversation.lastMessageAt ?? null,
    lastMessagePreview: conversation.lastMessagePreview ?? null,
    unreadCount: typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : 0,
  };
}
