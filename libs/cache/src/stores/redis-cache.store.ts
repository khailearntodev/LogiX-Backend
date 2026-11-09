import { Logger } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import type { CacheStore } from '../cache.interfaces.js';

export interface RedisCacheStoreOptions {
  /** Connection URL (`redis://[:password@]host:port[/db]` or `rediss://...`). */
  url: string;
  /** Maximum time in ms to wait for a Redis command before failing open. Defaults to 1500ms. */
  commandTimeoutMs?: number;
  /** Optional pre-configured ioredis client (useful for testing or custom cluster setups). */
  client?: Redis;
}

/**
 * Distributed Redis Cache Store (L2 Out-of-Process Cache) powered by `ioredis`.
 *
 * Production Hardening Configuration:
 * - `lazyConnect: true`: Does not block NestJS bootstrap if Redis is still warming up.
 * - `enableOfflineQueue: false`: Immediately throws when disconnected so `LogixCacheService`
 *   can fail-open to L1 / PostgreSQL in <1ms instead of hanging HTTP requests in a queue.
 * - `maxRetriesPerRequest: 1`: Prevents slow retry loops on the hot request path.
 * - Uses `UNLINK` instead of `DEL` so large values are reclaimed asynchronously on a background
 *   Redis thread without blocking the single-threaded Redis event loop.
 */
export class RedisCacheStore implements CacheStore {
  private readonly logger = new Logger(RedisCacheStore.name);
  private readonly client: Redis;

  constructor(options: RedisCacheStoreOptions) {
    if (options.client) {
      this.client = options.client;
      return;
    }

    const timeoutMs = options.commandTimeoutMs ?? 1_500;
    const redisOptions: RedisOptions = {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: timeoutMs,
      commandTimeout: timeoutMs,
      retryStrategy: (times: number) => Math.min(times * 250, 5_000),
    };

    this.client = new Redis(options.url, redisOptions);

    // Prevent unhandled 'error' events from crashing the Node.js process when Redis is unreachable
    this.client.on('error', (err: Error) => {
      this.logger.warn(`Redis connection error: ${err.message}`);
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.client.status === 'wait') {
      await this.client.connect();
    }
  }

  async getRaw(fullKey: string): Promise<string | null> {
    await this.ensureReady();
    return this.client.get(fullKey);
  }

  async setRaw(
    fullKey: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.ensureReady();
    const validTtl = Math.max(1, Math.floor(ttlSeconds));
    await this.client.set(fullKey, value, 'EX', validTtl);
  }

  async setIfNotExistsRaw(
    fullKey: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    await this.ensureReady();
    const validTtl = Math.max(1, Math.floor(ttlSeconds));
    const reply = await this.client.set(fullKey, value, 'EX', validTtl, 'NX');
    return reply === 'OK';
  }

  async delRaw(fullKeys: string[]): Promise<number> {
    if (fullKeys.length === 0) {
      return 0;
    }
    await this.ensureReady();
    // UNLINK is the non-blocking asynchronous equivalent of DEL in Redis >= 4.0
    return this.client.unlink(...fullKeys);
  }

  async ping(): Promise<boolean> {
    try {
      await this.ensureReady();
      const reply = await this.client.ping();
      return reply === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      if (
        this.client.status === 'ready' ||
        this.client.status === 'connecting'
      ) {
        await this.client.quit();
      } else {
        this.client.disconnect();
      }
    } catch {
      this.client.disconnect();
    }
  }
}
