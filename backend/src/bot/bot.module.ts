import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { ConversationModule } from '../conversation/conversation.module';
import { MessageModule } from '../message/message.module';

@Module({
  imports: [ConversationModule, MessageModule],
  providers: [BotService],
  exports: [BotService],
})
export class BotModule {}
