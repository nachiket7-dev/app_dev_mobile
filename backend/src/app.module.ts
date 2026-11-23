import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { ConversationModule } from './conversation/conversation.module';
import { MessageModule } from './message/message.module';
import { FileModule } from './file/file.module';
import { BotModule } from './bot/bot.module';
import { CONFIG } from './common/config';
import { HealthController } from './health.controller';

const isBotMode = CONFIG.botMode;

@Module({
  controllers: [HealthController],
  imports: [
    PrismaModule,
    AuthModule,
    UserModule,
    ConversationModule,
    MessageModule,
    FileModule,
    // BotModule only loaded when BOT_MODE=true
    ...(isBotMode ? [BotModule] : []),
  ],
})
export class AppModule {}
