import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateConversationDto } from './dto/conversation.dto';
import { canonicalDmKey, cleanName, MAX_PARTICIPANTS, normalizeObjectId } from '../common/input.util';
import { inTransaction, isUniqueCollision } from '../prisma/transaction';
import {
  assertCanonicalConversation, CONVERSATION_SELECT, conversationResponse, requireConversationMember,
} from './conversation-access';

@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  async getUserConversations(userId: string) {
    const callerId = normalizeObjectId(userId);
    const conversations = await this.prisma.conversation.findMany({
      where: { participants_ids: { has: callerId } },
      orderBy: [{ activityAt: 'desc' }, { id: 'desc' }],
      select: CONVERSATION_SELECT,
    });
    return conversations.map((conversation) => {
      assertCanonicalConversation(conversation);
      return conversationResponse(conversation, callerId);
    });
  }

  async getConversation(conversationId: string, userId: string) {
    const callerId = normalizeObjectId(userId);
    return conversationResponse(await requireConversationMember(this.prisma, conversationId, callerId), callerId);
  }

  async createConversation(dto: CreateConversationDto, userId: string) {
    const callerId = normalizeObjectId(userId);
    const ids = new Set((dto.participants_ids ?? []).map(normalizeObjectId));
    if (dto.recipient_id !== undefined) ids.add(normalizeObjectId(dto.recipient_id));
    ids.add(callerId);
    const participants = [...ids].sort();
    if (participants.length < 2 || participants.length > MAX_PARTICIPANTS) {
      throw new BadRequestException(`Conversations need 2 to ${MAX_PARTICIPANTS} distinct participants`);
    }
    const type = dto.type ?? (participants.length === 2 ? 'DM' : 'GROUP');
    if (type !== 'DM' && type !== 'GROUP') throw new BadRequestException('Invalid conversation type');
    if (type === 'DM' && participants.length !== 2) {
      throw new BadRequestException('A DM requires exactly two distinct participants, including its caller');
    }
    const name = dto.name === undefined || dto.name === null ? null : cleanName(dto.name);
    const key = type === 'DM' ? canonicalDmKey(participants) : `group:${randomUUID()}`;

    try {
      const conversation = await inTransaction(this.prisma, async (tx) => {
        if (type === 'DM') {
          const existing = await tx.conversation.findUnique({ where: { conversationKey: key }, select: CONVERSATION_SELECT });
          if (existing) {
            assertCanonicalConversation(existing);
            return existing;
          }
        }
        const foundUsers = await tx.user.count({ where: { id: { in: participants } } });
        if (foundUsers !== participants.length) throw new NotFoundException('One or more participant users not found');
        const created = await tx.conversation.create({
          data: {
            type, name: type === 'DM' ? null : name, conversationKey: key,
            createdBy: callerId, participants_ids: participants,
            unreadCounts: Object.fromEntries(participants.map((id) => [id, 0])),
          },
          select: CONVERSATION_SELECT,
        });
        await tx.user.updateMany({
          where: { id: { in: participants } }, data: { conversationIds: { push: created.id } },
        });
        return created;
      });
      return conversationResponse(conversation, callerId);
    } catch (error) {
      if (type !== 'DM' || !isUniqueCollision(error)) throw error;
      const existing = await this.prisma.conversation.findUnique({ where: { conversationKey: key }, select: CONVERSATION_SELECT });
      if (!existing) throw error;
      assertCanonicalConversation(existing);
      return conversationResponse(existing, callerId);
    }
  }
}
