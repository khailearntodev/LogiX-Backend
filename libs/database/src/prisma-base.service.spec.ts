import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from './database.module.js';
import {
  PrismaBaseService,
  resolvePrismaPgConfig,
  withPrismaLifecycle,
} from './prisma-base.service.js';

class FakeClient {
  $connect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  $disconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  $queryRawUnsafe = vi.fn<(query: string) => Promise<unknown>>().mockResolvedValue([{ result: 1 }]);
}

class TestPrismaService extends withPrismaLifecycle(FakeClient) {}

afterEach(() => vi.restoreAllMocks());

describe('Prisma lifecycle', () => {
  it('connects and disconnects through Nest lifecycle hooks', async () => {
    const service = new TestPrismaService();
    const log = vi.spyOn(service.logger, 'log').mockImplementation(() => undefined);
    await service.onModuleInit();
    await service.onModuleDestroy();
    expect(service.$connect).toHaveBeenCalledExactlyOnceWith();
    expect(service.$disconnect).toHaveBeenCalledExactlyOnceWith();
    expect(log).toHaveBeenCalledTimes(4);
  });

  it.each(['onModuleInit', 'onModuleDestroy'] as const)(
    'propagates database failure from %s',
    async (hook) => {
      const service = new TestPrismaService();
      vi.spyOn(service.logger, 'log').mockImplementation(() => undefined);
      const failure = new Error('QA database unavailable');
      const operation = hook === 'onModuleInit' ? service.$connect : service.$disconnect;
      operation.mockRejectedValueOnce(failure);
      await expect(service[hook]()).rejects.toBe(failure);
    },
  );

  it('executes a database probe before reporting healthy', async () => {
    const service = new TestPrismaService();
    await expect(service.isHealthy()).resolves.toBe(true);
    expect(service.$queryRawUnsafe).toHaveBeenCalledExactlyOnceWith('SELECT 1');
  });

  it('reports unhealthy and logs when the probe rejects', async () => {
    const service = new TestPrismaService();
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service.$queryRawUnsafe.mockRejectedValueOnce(new Error('QA probe failure'));
    await expect(service.isHealthy()).resolves.toBe(false);
    expect(log).toHaveBeenCalledExactlyOnceWith('Database health check failed');
  });
});

describe('DatabaseModule', () => {
  it('aliases the service-specific client to the shared provider', () => {
    expect(DatabaseModule.forRoot({ prismaServiceClass: TestPrismaService })).toEqual({
      module: DatabaseModule,
      global: true,
      providers: [
        { provide: PrismaBaseService, useClass: TestPrismaService },
        { provide: TestPrismaService, useExisting: PrismaBaseService },
      ],
      exports: [PrismaBaseService, TestPrismaService],
    });
  });
});

describe('resolvePrismaPgConfig', () => {
  it('resolves pool defaults and explicit overrides from validated config', () => {
    const defaults = resolvePrismaPgConfig({
      get: <T>(key: string) =>
        (key === 'DATABASE_URL' ? 'postgresql://u:p@localhost:5433/db' : undefined) as T,
    });
    expect(defaults).toEqual({
      connectionString: 'postgresql://u:p@localhost:5433/db',
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    const custom = resolvePrismaPgConfig({
      get: <T>(key: string) =>
        ({
          DATABASE_URL: 'postgresql://u:p@localhost:5433/db',
          DB_POOL_MAX: 35,
          DB_POOL_IDLE_TIMEOUT_MS: 15_000,
          DB_POOL_CONNECTION_TIMEOUT_MS: 5_000,
        })[key] as T,
    });
    expect(custom).toEqual({
      connectionString: 'postgresql://u:p@localhost:5433/db',
      max: 35,
      idleTimeoutMillis: 15_000,
      connectionTimeoutMillis: 5_000,
    });
  });

  it('fails fast when DATABASE_URL is missing or pool bounds are invalid', () => {
    expect(() =>
      resolvePrismaPgConfig({ get: () => undefined }),
    ).toThrow('DATABASE_URL is required');
    expect(() =>
      resolvePrismaPgConfig({
        get: <T>(key: string) =>
          ({
            DATABASE_URL: 'postgresql://u:p@localhost:5433/db',
            DB_POOL_MAX: 0,
          })[key] as T,
      }),
    ).toThrow('DB_POOL_MAX');
  });
});
