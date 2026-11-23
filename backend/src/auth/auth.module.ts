import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';

/**
 * AuthModule registers AuthGuard globally via APP_GUARD.
 * Protected endpoints require a valid raw Basic auth header.
 * Explicit @Public() routes, including /health, never authenticate or register users.
 * PrismaService is available because PrismaModule is @Global().
 */
@Module({
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class AuthModule {}
