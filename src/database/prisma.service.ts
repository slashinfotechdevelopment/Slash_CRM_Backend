import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';

import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const adapter = new PrismaMariaDb({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'slash_infotech_crm',
      connectionLimit: 10,
      allowPublicKeyRetrieval: true,
      connectTimeout: 10000,
      acquireTimeout: 10000,
    });

    super({ adapter });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      // Probe active connection to warm up pool and fail-fast at startup if MySQL handshake fails
      await this.$queryRawUnsafe('SELECT 1');
      console.log('MySQL database connected successfully');
    } catch (error) {
      console.error(
        'MySQL database connection failed:',
        (error as any)?.message || error,
      );
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}