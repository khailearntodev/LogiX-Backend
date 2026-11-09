import { DynamicModule, Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LOGIX_CACHE_OPTIONS,
  LOGIX_CACHE_STORE,
  type CacheStore,
  type LogixCacheModuleOptions,
} from './cache.interfaces.js';
import { LogixCacheService } from './cache.service.js';
import { InMemoryCacheStore } from './stores/in-memory-cache.store.js';
import { RedisCacheStore } from './stores/redis-cache.store.js';

/**
 * LogixCacheModule — Shared Distributed Cache Module (`@logix/cache`).
 *
 * Register once in any microservice's `AppModule`:
 * ```ts
 * LogixCacheModule.forRoot({ servicePrefix: 'notif' })
 * ```
 *
 * Automatically connects to `REDIS_URL` (Distributed L2 Cache) when present,
 * or falls back to `InMemoryCacheStore` (L1 Cache) in local/unit-test environments.
 */
@Global()
@Module({})
export class LogixCacheModule {
  private static readonly logger = new Logger(LogixCacheModule.name);

  static forRoot(options: LogixCacheModuleOptions): DynamicModule {
    return {
      module: LogixCacheModule,
      global: true,
      providers: [
        {
          provide: LOGIX_CACHE_OPTIONS,
          useValue: options,
        },
        {
          provide: LOGIX_CACHE_STORE,
          inject: [{ token: ConfigService, optional: true }],
          useFactory: (configService?: ConfigService): CacheStore => {
            const redisUrl =
              options.redisUrl ??
              configService?.get<string>('REDIS_URL') ??
              process.env.REDIS_URL;

            if (redisUrl && redisUrl.trim().length > 0) {
              this.logger.log(
                `Initializing RedisCacheStore (Distributed Cache) for prefix "${options.servicePrefix}"`,
              );
              return new RedisCacheStore({
                url: redisUrl.trim(),
                commandTimeoutMs: options.commandTimeoutMs ?? 1_500,
              });
            }

            this.logger.log(
              `REDIS_URL not set; using InMemoryCacheStore (L1) for prefix "${options.servicePrefix}"`,
            );
            return new InMemoryCacheStore(options.maxFallbackEntries ?? 2_000);
          },
        },
        LogixCacheService,
      ],
      exports: [LogixCacheService, LOGIX_CACHE_STORE, LOGIX_CACHE_OPTIONS],
    };
  }
}

