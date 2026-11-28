import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { resolvePrismaPgConfig, withPrismaLifecycle } from '@logix/database';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * PrismaService for master-data-service.
 *
 * Extends service-specific generated PrismaClient wrapped with
 * lifecycle hooks, logging, and health checking from @logix/database.
 */
@Injectable()
export class PrismaService extends withPrismaLifecycle(PrismaClient) {
  constructor(config: ConfigService) {
    super({ adapter: new PrismaPg(resolvePrismaPgConfig(config)) });
  }
}
