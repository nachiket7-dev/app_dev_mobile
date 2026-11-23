import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FACTS } from './facts.data';
import { BOT_NAME } from '../common/input.util';
import { CONFIG } from '../common/config';
import { ConversationService } from '../conversation/conversation.service';
import { MessageService } from '../message/message.service';
import { isUniqueCollision } from '../prisma/transaction';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private timer: NodeJS.Timeout | null = null;
  private botUserId: string | null = null;
  private factIndex = 0;
  private cursor: string | undefined;
  private busy = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationService,
    private readonly messages: MessageService,
  ) {}

  async onModuleInit() {
    let bot = await this.prisma.user.findUnique({ where: { name: BOT_NAME } });
    if (!bot) {
      try {
        bot = await this.prisma.user.create({ data: {
          name: BOT_NAME, isBot: true, passwordHash: null, phone: null, bio: 'Automated demo facts', conversationIds: [],
        } });
      } catch (error) {
        if (!isUniqueCollision(error)) throw error;
        bot = await this.prisma.user.findUnique({ where: { name: BOT_NAME } });
      }
    }
    if (!bot?.isBot || bot.passwordHash || bot.phone) throw new Error('Reserved bot identity requires reviewed migration');
    this.botUserId = bot.id;
    this.timer = setInterval(() => { void this.tick(); }, CONFIG.botIntervalMs);
    this.timer.unref();
    this.logger.log('Opt-in demo bot enabled with bounded, non-overlapping ticks');
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy || this.stopped || !this.botUserId) return;
    this.busy = true;
    try {
      const users = await this.prisma.user.findMany({
        where: { isBot: false, ...(this.cursor ? { id: { gt: this.cursor } } : {}) },
        orderBy: { id: 'asc' }, take: CONFIG.botBatchSize, select: { id: true },
      });
      this.cursor = users.length === CONFIG.botBatchSize ? users[users.length - 1].id : undefined;
      for (const user of users) {
        if (this.stopped) break;
        const conversation = await this.conversations.createConversation({ type: 'DM', participants_ids: [user.id] }, this.botUserId);
        await this.messages.createMessage({
          conversation_id: conversation.id, content: FACTS[this.factIndex++ % FACTS.length],
        }, this.botUserId);
      }
    } catch {
      this.logger.warn('Demo bot tick failed; no message content or credentials logged');
    } finally { this.busy = false; }
  }
}
