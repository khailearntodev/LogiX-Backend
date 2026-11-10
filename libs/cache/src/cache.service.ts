import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { CacheKeyBuilder } from './cache-key.builder.js';
import {
  LOGIX_CACHE_OPTIONS,
  LOGIX_CACHE_STORE,
  type CacheStore,
  type LogixCacheModuleOptions,
} from './cache.interfaces.js';
import { InMemoryCacheStore } from './stores/in-memory-cache.store.js';

const DEFAULT_TTL_SECONDS = 300;

/**
 * LogixCacheService — Unified Multi-Tenant Caching Facade for LogiX Microservices.
 *
 * Key Guarantees:
 * 1. **Strict Tenant Isolation (`NFR-SEC-001`)**: Every operation requires `tenantId`
 *    and scopes keys under `{servicePrefix}:t:{tenantId}:{key}`.
 * 2. **Cache-Aside (`getOrSet`)**: Checks cache first; on miss, invokes `loader()`,
 *    serializes the result to JSON with `ttlSeconds`, and returns it.
 * 3. **Atomic Cooldown / Rate-Limiting (`acquireCooldownLock`)**: Uses `SET key val EX ttl NX`
 *    to prevent duplicate alerts (e.g., `LOW_STOCK` notification storms).
 * 4. **Fail-Open Degradation**: PostgreSQL remains the source of truth (`data-ownership.md §6`).
 *    If Redis is temporarily unreachable, operations log a warning and fall back to the
 *    bounded L1 `InMemoryCacheStore` instead of failing the business request.
 */
@Injectable()
export class LogixCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(LogixCacheService.name);
  private readonly keyBuilder: CacheKeyBuilder;
  private readonly defaultTtlSeconds: number;
  private readonly fallbackStore: InMemoryCacheStore;

  constructor(
    @Inject(LOGIX_CACHE_OPTIONS)
    private readonly options: LogixCacheModuleOptions,
    @Inject(LOGIX_CACHE_STORE)
    private readonly primaryStore: CacheStore,
  ) {
    this.keyBuilder = new CacheKeyBuilder(options.servicePrefix);
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
    this.fallbackStore = new InMemoryCacheStore(options.maxFallbackEntries ?? 2_000);
  }

  /**
   * Returns the canonical tenant-scoped Redis key (`{servicePrefix}:t:{tenantId}:{key}`).
   */
  buildTenantKey(tenantId: string, key: string): string {
    return this.keyBuilder.forTenant(tenantId, key);
  }

  /**
   * Read and deserialize a JSON-cached value for a specific tenant.
   * Returns `null` on cache miss or deserialization failure.
   */
  async get<T>(tenantId: string, key: string): Promise<T | null> {
    const fullKey = this.keyBuilder.forTenant(tenantId, key);
    let raw: string | null = null;

    try {
      raw = await this.primaryStore.getRaw(fullKey);
    } catch (error) {
      this.logFallbackWarning('get', fullKey, error);
      raw = await this.fallbackStore.getRaw(fullKey);
    }

    if (raw === null) {
      return null;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      await this.del(tenantId, key);
      return null;
    }
  }

  /**
   * Serialize and store a value in the tenant-scoped cache with TTL (seconds).
   */
  async set<T>(
    tenantId: string,
    key: string,
    value: T,
    ttlSeconds = this.defaultTtlSeconds,
  ): Promise<void> {
    const fullKey = this.keyBuilder.forTenant(tenantId, key);
    const serialized = JSON.stringify(value);
    const effectiveTtl = Math.max(1, Math.floor(ttlSeconds));

    try {
      await this.primaryStore.setRaw(fullKey, serialized, effectiveTtl);
    } catch (error) {
      this.logFallbackWarning('set', fullKey, error);
      await this.fallbackStore.setRaw(fullKey, serialized, effectiveTtl);
    }
  }

  /**
   * Pattern 1: Cache-Aside (Lazy Loading).
   *
   * 1. Probes the cache for `{servicePrefix}:t:{tenantId}:{key}`.
   * 2. On HIT, returns the cached value immediately.
   * 3. On MISS, executes `loader()`, stores the result if non-undefined, and returns it.
   */
  async getOrSet<T>(
    tenantId: string,
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.get<T>(tenantId, key);
    if (cached !== null) {
      return cached;
    }

    const freshValue = await loader();
    if (freshValue !== undefined && freshValue !== null) {
      await this.set(tenantId, key, freshValue, ttlSeconds);
    }
    return freshValue;
  }

  /**
   * Pattern 2: Explicit Cache Invalidation.
   * Deletes one or more keys belonging to `tenantId` from both primary and fallback stores.
   */
  async del(
    tenantId: string,
    keyOrKeys: string | readonly string[],
  ): Promise<number> {
    const keys = typeof keyOrKeys === 'string' ? [keyOrKeys] : keyOrKeys;
    if (keys.length === 0) {
      return 0;
    }
    const fullKeys = keys.map((k) => this.keyBuilder.forTenant(tenantId, k));

    await this.fallbackStore.delRaw(fullKeys);
    try {
      return await this.primaryStore.delRaw(fullKeys);
    } catch (error) {
      this.logFallbackWarning('del', fullKeys.join(','), error);
      return 0;
    }
  }

  /**
   * Pattern 3: Atomic Cooldown / Rate-Limit Lock (`SET key "1" EX ttl NX`).
   *
   * Returns `true` if the caller acquired the cooldown window (action should proceed),
   * or `false` if the action is still within its cooldown period (should be suppressed).
   */
  async acquireCooldownLock(
    tenantId: string,
    cooldownKey: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const fullKey = this.keyBuilder.forTenant(
      tenantId,
      `cooldown:${cooldownKey}`,
    );
    const effectiveTtl = Math.max(1, Math.floor(ttlSeconds));
    const lockMarker = String(Date.now());

    try {
      return await this.primaryStore.setIfNotExistsRaw(
        fullKey,
        lockMarker,
        effectiveTtl,
      );
    } catch (error) {
      this.logFallbackWarning('acquireCooldownLock', fullKey, error);
      return this.fallbackStore.setIfNotExistsRaw(
        fullKey,
        lockMarker,
        effectiveTtl,
      );
    }
  }

  /**
   * Explicitly release a cooldown lock early (e.g. when stock is replenished above threshold).
   */
  async releaseCooldownLock(
    tenantId: string,
    cooldownKey: string,
  ): Promise<void> {
    await this.del(tenantId, `cooldown:${cooldownKey}`);
  }

  async ping(): Promise<boolean> {
    return this.primaryStore.ping();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this.primaryStore.close(),
      this.fallbackStore.close(),
    ]);
  }

  private logFallbackWarning(
    operation: string,
    fullKey: string,
    error: unknown,
  ): void {
    const reason =
      error instanceof Error ? error.message : 'Unknown cache store error';
    this.logger.warn(
      `[Fail-Open Cache] Primary store failed during ${operation} (${fullKey}): ${reason}. Using L1 fallback.`,
    );
  }
}

