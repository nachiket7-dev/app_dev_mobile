import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { verifyDatabaseReady, DatabaseSafetyError } from './database';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  ready = false;

  async onModuleInit() {
    try {
      await this.$connect();
      await verifyDatabaseReady(this);
      this.ready = true;
    } catch (error) {
      await this.$disconnect();
      throw new Error(error instanceof DatabaseSafetyError ? error.message : 'Database unavailable; verify replica set, configuration and db:provision');
    }
  }

  async onModuleDestroy() {
    this.ready = false;
    await this.$disconnect();
  }
}
