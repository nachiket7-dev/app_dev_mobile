import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from './auth/public.decorator';
import { PrismaService } from './prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Public readiness and included-backend capabilities; never registers an account' })
  async health() {
    if (!this.prisma.ready) throw new ServiceUnavailableException('Database is not ready');
    try { await this.prisma.$runCommandRaw({ ping: 1 }); } catch {
      throw new ServiceUnavailableException('Database is unavailable');
    }
    return {
      status: 'ok', version: '1.1.0', apiVersion: 1,
      capabilities: { idempotency: true, receipts: true, conversationSummary: true },
    };
  }
}
