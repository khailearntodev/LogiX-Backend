import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

export interface PrismaClientLike {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $queryRawUnsafe?(query: string, ...values: unknown[]): Promise<unknown>;
}

export type Constructor<T = object> = new (...args: any[]) => T;

/**
 * Mixin that adds NestJS lifecycle hooks ($connect / $disconnect),
 * structured logging, and health checking to any service-generated PrismaClient.
 *
 * Usage:
 * ```typescript
 * import { Injectable } from '@nestjs/common';
 * import { ConfigService } from '@nestjs/config';
 * import { PrismaPg } from '@prisma/adapter-pg';
 * import { withPrismaLifecycle } from '@logix/database';
 * import { PrismaClient } from '../generated/prisma/client.js';
 *
 * @Injectable()
 * export class PrismaService extends withPrismaLifecycle(PrismaClient) {
 *   constructor(config: ConfigService) {
 *     const connectionString = config.get<string>('DATABASE_URL');
 *     if (!connectionString) {
 *       throw new Error('DATABASE_URL is required');
 *     }
 *     super({ adapter: new PrismaPg({ connectionString }) });
 *   }
 * }
 * ```
 *
 * @see docs/architecture/data-ownership.md — each service owns its persistence
 */
export function withPrismaLifecycle<TBase extends Constructor<PrismaClientLike>>(
  BaseClient: TBase,
) {
  @Injectable()
  abstract class PrismaLifecycleService
    extends BaseClient
    implements OnModuleInit, OnModuleDestroy
  {
    readonly logger = new Logger(this.constructor.name);

    async onModuleInit(): Promise<void> {
      this.logger.log('Connecting to database...');
      await this.$connect();
      this.logger.log('Database connection established');
    }

    async onModuleDestroy(): Promise<void> {
      this.logger.log('Disconnecting from database...');
      await this.$disconnect();
      this.logger.log('Database connection closed');
    }

    /**
     * Health check — verifies the database connection is alive.
     * Used by readiness probes in Kubernetes.
     */
    async isHealthy(): Promise<boolean> {
      try {
        if (typeof this.$queryRawUnsafe === 'function') {
          await this.$queryRawUnsafe('SELECT 1');
        }
        return true;
      } catch {
        this.logger.error('Database health check failed');
        return false;
      }
    }
  }

  return PrismaLifecycleService;
}

/**
 * Abstract class representing the database service contract.
 */
export abstract class PrismaBaseService
  implements OnModuleInit, OnModuleDestroy, PrismaClientLike
{
  abstract $connect(): Promise<void>;
  abstract $disconnect(): Promise<void>;
  abstract onModuleInit(): Promise<void>;
  abstract onModuleDestroy(): Promise<void>;
  abstract isHealthy(): Promise<boolean>;
}
