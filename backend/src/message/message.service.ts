import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AcknowledgeMessagesDto, CreateMessageDto } from './dto/message.dto';
import { FILE_META_SELECT, toFileResponse } from '../file/file.service';
import { requireConversationMember } from '../conversation/conversation-access';
import { cleanContent, normalizeObjectId } from '../common/input.util';
import { decodeBase64, MAX_INLINE_IMAGE_BYTES } from '../common/base64.util';
import { validateRasterImage } from '../common/image.util';
import { inTransaction, isUniqueCollision } from '../prisma/transaction';
import { messagePreview, receipts, unreadCounts } from './summary';

export const PAGE_SIZE = 20;
const MESSAGE_SELECT = {
  id: true, content: true, imageInfo: true, createdAt: true, senderId: true,
  conversationId: true, status: true, fileId: true, clientMessageId: true,
} as const;
type Message = Prisma.MessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

@Injectable()
export class MessageService {
  constructor(private readonly prisma: PrismaService) {}

  async getMessages(conversationId: string, callerId: string, fromMessageCursor?: string) {
    const roomId = normalizeObjectId(conversationId);
    await requireConversationMember(this.prisma, roomId, callerId);
    const where: Prisma.MessageWhereInput = { conversationId: roomId };
    if (fromMessageCursor) {
      const cursor = await this.prisma.message.findUnique({
        where: { id: normalizeObjectId(fromMessageCursor) },
        select: { id: true, createdAt: true, conversationId: true },
      });
      if (!cursor || cursor.conversationId !== roomId) throw new BadRequestException('Cursor must belong to this conversation');
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }
    const fetched = await this.prisma.message.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: PAGE_SIZE + 1, select: MESSAGE_SELECT,
    });
    const page = fetched.slice(0, PAGE_SIZE);
    const data = await this.withAttachments([...page].reverse());
    return { data, nextCursor: fetched.length > PAGE_SIZE ? page[page.length - 1].id : null, count: data.length };
  }

  async createMessage(dto: CreateMessageDto, userId: string) {
    const senderId = normalizeObjectId(userId);
    const roomId = normalizeObjectId(dto.conversation_id);
    // Authorize before fetching attachments or decoding potentially large legacy images.
    await requireConversationMember(this.prisma, roomId, senderId);
    const content = cleanContent(dto.content);
    const fileId = dto.file_id === undefined || dto.file_id === null ? null : normalizeObjectId(dto.file_id);
    let imageInfo: string | null = null;
    if (dto.imageInfo !== undefined && dto.imageInfo !== null) {
      const decoded = decodeBase64(dto.imageInfo, MAX_INLINE_IMAGE_BYTES);
      const mime = await validateRasterImage(decoded.buffer);
      if (!mime) throw new BadRequestException('imageInfo must contain a decodable raster image');
      imageInfo = `data:${mime};base64,${decoded.buffer.toString('base64')}`;
    }
    if (!content && !imageInfo && !fileId) throw new BadRequestException('Message must contain content, imageInfo or file_id');
    if (fileId && imageInfo) throw new BadRequestException('Send either file_id or imageInfo, not both');
    const clientMessageId = dto.client_message_id?.toLowerCase() ?? null;
    if (clientMessageId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clientMessageId)) {
      throw new BadRequestException('client_message_id must be a UUID');
    }
    const sendKey = clientMessageId ? `client:${senderId}:${roomId}:${clientMessageId}` : `internal:${randomUUID()}`;
    const assertReplay = (message: Message) => {
      if (message.content !== content || message.imageInfo !== imageInfo || message.fileId !== fileId ||
          message.senderId !== senderId || message.conversationId !== roomId) {
        throw new ConflictException('client_message_id was already used with different content');
      }
    };
    try {
      return await inTransaction(this.prisma, async (tx) => {
        const conversation = await requireConversationMember(tx, roomId, senderId);
        const existing = clientMessageId
          ? await tx.message.findUnique({ where: { sendKey }, select: MESSAGE_SELECT }) : null;
        if (existing) assertReplay(existing);
        const file = fileId ? await tx.file.findUnique({ where: { id: fileId }, select: FILE_META_SELECT }) : null;
        if (fileId && !file) throw new NotFoundException('File not found');
        if (file && file.uploadedBy !== senderId) throw new ForbiddenException('You can only send files you uploaded');
        if (existing) return this.messageResponse(existing, file ? toFileResponse(file) : null);
        const status = Object.fromEntries(conversation.participants_ids.map((id) =>
          [id, { delivered: id === senderId, read: id === senderId }],
        ));
        const message = await tx.message.create({
          data: { content, imageInfo, senderId, conversationId: roomId, status, fileId, sendKey, clientMessageId },
          select: MESSAGE_SELECT,
        });
        const counts = unreadCounts(conversation.unreadCounts, conversation.participants_ids);
        for (const id of conversation.participants_ids) if (id !== senderId) counts[id]++;
        const newer = !conversation.lastMessageAt || message.createdAt > conversation.lastMessageAt ||
          (message.createdAt.getTime() === conversation.lastMessageAt.getTime() && message.id > (conversation.lastMessageId ?? ''));
        await tx.conversation.update({
          where: { id: roomId },
          data: {
            unreadCounts: counts,
            ...(newer ? { activityAt: message.createdAt, lastMessageAt: message.createdAt, lastMessageId: message.id,
              lastMessagePreview: messagePreview(content, file?.kind, !!imageInfo) } : {}),
          }, select: { id: true },
        });
        // Build the entire response before commit. There is no fallible response read after it.
        return this.messageResponse(message, file ? toFileResponse(file) : null);
      });
    } catch (error) {
      if (!clientMessageId || !isUniqueCollision(error)) throw error;
      const existing = await this.prisma.message.findUnique({ where: { sendKey }, select: MESSAGE_SELECT });
      if (!existing) throw error;
      assertReplay(existing);
      const [response] = await this.withAttachments([existing]);
      return response;
    }
  }

  async acknowledge(dto: AcknowledgeMessagesDto, userId: string) {
    const callerId = normalizeObjectId(userId);
    const roomId = normalizeObjectId(dto.conversation_id);
    if (!Array.isArray(dto.message_ids) || !dto.message_ids.length || dto.message_ids.length > 100 ||
        !['delivered', 'read'].includes(dto.status)) throw new BadRequestException('Invalid acknowledgement batch');
    const ids = [...new Set(dto.message_ids.map(normalizeObjectId))];
    return inTransaction(this.prisma, async (tx) => {
      const conversation = await requireConversationMember(tx, roomId, callerId);
      const messages = await tx.message.findMany({
        where: { id: { in: ids }, conversationId: roomId }, select: { id: true, status: true, senderId: true },
      });
      if (messages.length !== ids.length) throw new BadRequestException('All message_ids must belong to this conversation');
      let newlyRead = 0;
      const updates: Prisma.InputJsonObject[] = [];
      for (const message of messages) {
        const status = receipts(message.status);
        const current = status[callerId] ?? { delivered: false, read: false };
        const read = current.read || dto.status === 'read';
        if (read && !current.read && message.senderId !== callerId) newlyRead++;
        if (!current.delivered || read !== current.read) {
          updates.push({
            q: { _id: { $oid: message.id }, conversationId: { $oid: roomId } },
            u: { $set: { [`status.${callerId}.delivered`]: true, [`status.${callerId}.read`]: read } },
          });
        }
      }
      if (updates.length) {
        // One batch avoids 100 serial round trips/long-held locks. Never replace other users' receipts.
        const result = await tx.$runCommandRaw({ update: 'messages', updates, ordered: true }) as {
          n?: number | { $numberLong: string };
        };
        const matched = typeof result.n === 'object' ? Number(result.n.$numberLong) : Number(result.n);
        if (matched !== updates.length) throw new ConflictException('Messages changed during acknowledgement; retry');
      }
      if (newlyRead) {
        const counts = unreadCounts(conversation.unreadCounts, conversation.participants_ids);
        counts[callerId] = Math.max(0, counts[callerId] - newlyRead);
        await tx.conversation.update({ where: { id: roomId }, data: { unreadCounts: counts }, select: { id: true } });
      }
      return { status: 'ok', acknowledged: ids.length };
    });
  }

  private messageResponse(message: Message, file: ReturnType<typeof toFileResponse> | null) {
    const { clientMessageId, ...fields } = message;
    return {
      ...fields, ...(clientMessageId ? { clientMessageId } : {}), fileId: message.fileId ?? null,
      type: file?.kind ?? (message.imageInfo ? 'IMAGE' : 'TEXT'), file,
    };
  }

  private async withAttachments(messages: Message[]) {
    const fileIds = [...new Set(messages.map((message) => message.fileId).filter((id): id is string => !!id))];
    const files = fileIds.length ? await this.prisma.file.findMany({ where: { id: { in: fileIds } }, select: FILE_META_SELECT }) : [];
    const byId = new Map(files.map((file) => [file.id, toFileResponse(file)]));
    return messages.map((message) => this.messageResponse(message, message.fileId ? byId.get(message.fileId) ?? null : null));
  }
}
