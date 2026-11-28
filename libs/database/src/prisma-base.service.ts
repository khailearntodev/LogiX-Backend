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

export interface PrismaPoolConfig {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

export interface DatabaseConfigReader {
  get<T = unknown>(key: string): T | undefined;
}

const DEFAULT_DB_POOL_MAX = 20;
const DEFAULT_DB_POOL_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_DB_POOL_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Resolves pg.Pool options for PrismaPg from validated service config.
 * Fails fast if DATABASE_URL is absent; applies bounded defaults for pool tunables
 * so services never silently fall back to node-postgres's 10-connection default under load.
 */
export function resolvePrismaPgConfig(
  config: DatabaseConfigReader,
): PrismaPoolConfig {
  const connectionString = config.get<string>('DATABASE_URL');
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const max = config.get<number>('DB_POOL_MAX') ?? DEFAULT_DB_POOL_MAX;
  const idleTimeoutMillis =
    config.get<number>('DB_POOL_IDLE_TIMEOUT_MS') ??
    DEFAULT_DB_POOL_IDLE_TIMEOUT_MS;
  const connectionTimeoutMillis =
    config.get<number>('DB_POOL_CONNECTION_TIMEOUT_MS') ??
    DEFAULT_DB_POOL_CONNECTION_TIMEOUT_MS;

  if (!Number.isSafeInteger(max) || max < 1 || max > 200) {
    throw new Error('DB_POOL_MAX must be an integer between 1 and 200');
  }
  if (!Number.isSafeInteger(idleTimeoutMillis) || idleTimeoutMillis < 1000) {
    throw new Error('DB_POOL_IDLE_TIMEOUT_MS must be an integer >= 1000');
  }
  if (
    !Number.isSafeInteger(connectionTimeoutMillis) ||
    connectionTimeoutMillis < 500
  ) {
    throw new Error('DB_POOL_CONNECTION_TIMEOUT_MS must be an integer >= 500');
  }

  return {
    connectionString,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
  };
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
