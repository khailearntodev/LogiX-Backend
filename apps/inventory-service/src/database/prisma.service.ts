import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { withPrismaLifecycle } from '@logix/database';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * PrismaService for inventory-service.
 *
 * Extends service-specific generated PrismaClient wrapped with
 * lifecycle hooks, logging, and health checking from @logix/database.
 */
@Injectable()
export class PrismaService extends withPrismaLifecycle(PrismaClient) {
  constructor(config: ConfigService) {
    const connectionString = config.get<string>('DATABASE_URL');

    if (!connectionString) {
      throw new Error('DATABASE_URL is required');
    }

    super({ adapter: new PrismaPg({ connectionString }) });
  }
}
