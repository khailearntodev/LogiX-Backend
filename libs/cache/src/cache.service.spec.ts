import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheKeyBuilder } from './cache-key.builder.js';
import type { CacheStore } from './cache.interfaces.js';
import { LogixCacheService } from './cache.service.js';
import { InMemoryCacheStore } from './stores/in-memory-cache.store.js';
import { RedisCacheStore } from './stores/redis-cache.store.js';

const TENANT_A = '01000000-0000-4000-8000-000000000001';
const TENANT_B = '02000000-0000-4000-8000-000000000002';

describe('@logix/cache — Multi-Tenant Distributed Cache (ioredis)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  describe('CacheKeyBuilder (Tenant & Service Boundary Isolation)', () => {
    it('constructs canonical {servicePrefix}:t:{tenantId}:{key} keys', () => {
      const builder = new CacheKeyBuilder('notif');
      expect(builder.forTenant(TENANT_A, 'u:123:unread')).toBe(
        `notif:t:${TENANT_A}:u:123:unread`,
      );
    });

    it('rejects invalid servicePrefix, blank tenantId, or keys with spaces', () => {
      expect(() => new CacheKeyBuilder('')).toThrow();
      expect(() => new CacheKeyBuilder('123-bad')).toThrow();

      const builder = new CacheKeyBuilder('notif');
      expect(() => builder.forTenant('', 'key')).toThrow();
      expect(() => builder.forTenant('bad tenant', 'key')).toThrow();
      expect(() => builder.forTenant(TENANT_A, '')).toThrow();
      expect(() => builder.forTenant(TENANT_A, 'invalid key')).toThrow();
    });
  });

  describe('LogixCacheService Patterns (Cache-Aside, Invalidation, Cooldown, Fail-Open)', () => {
    it('implements Cache-Aside (getOrSet) and isolates tenants strictly', async () => {
      const store = new InMemoryCacheStore();
      const cache = new LogixCacheService({ servicePrefix: 'notif' }, store);
      cleanups.push(() => cache.onModuleDestroy());

      let dbCalls = 0;
      const loader = async () => {
        dbCalls += 1;
        return { unreadCount: 7 };
      };

      // First call for Tenant A -> MISS -> calls loader
      const first = await cache.getOrSet(TENANT_A, 'u:user1:unread', 60, loader);
      expect(first).toEqual({ unreadCount: 7 });
      expect(dbCalls).toBe(1);

      // Second call for Tenant A -> HIT -> does NOT call loader
      const second = await cache.getOrSet(
        TENANT_A,
        'u:user1:unread',
        60,
        loader,
      );
      expect(second).toEqual({ unreadCount: 7 });
      expect(dbCalls).toBe(1);

      // Tenant B with the exact same user key -> MISS (strictly isolated!)
      const tenantBVal = await cache.get<{ unreadCount: number }>(
        TENANT_B,
        'u:user1:unread',
      );
      expect(tenantBVal).toBeNull();

      // Explicit invalidation on Tenant A
      await cache.del(TENANT_A, 'u:user1:unread');
      expect(await cache.get(TENANT_A, 'u:user1:unread')).toBeNull();
    });

    it('enforces atomic cooldown locks (SET NX EX) per tenant', async () => {
      const store = new InMemoryCacheStore();
      const cache = new LogixCacheService({ servicePrefix: 'notif' }, store);
      cleanups.push(() => cache.onModuleDestroy());

      const lockKey = 'low_stock:wh-1:prod-1';

      // First alert acquires the 900s cooldown window
      expect(await cache.acquireCooldownLock(TENANT_A, lockKey, 900)).toBe(true);
      // Subsequent alerts within cooldown window are suppressed
      expect(await cache.acquireCooldownLock(TENANT_A, lockKey, 900)).toBe(
        false,
      );
      // Another tenant is unaffected
      expect(await cache.acquireCooldownLock(TENANT_B, lockKey, 900)).toBe(true);

      // Releasing the lock allows immediate re-acquisition
      await cache.releaseCooldownLock(TENANT_A, lockKey);
      expect(await cache.acquireCooldownLock(TENANT_A, lockKey, 900)).toBe(true);
    });

    it('fails open gracefully to L1 fallback when Redis throws transient errors', async () => {
      const brokenPrimaryStore: CacheStore = {
        getRaw: vi
          .fn()
          .mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
        setRaw: vi
          .fn()
          .mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
        setIfNotExistsRaw: vi
          .fn()
          .mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
        delRaw: vi
          .fn()
          .mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
        ping: vi.fn().mockResolvedValue(false),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const cache = new LogixCacheService(
        { servicePrefix: 'notif' },
        brokenPrimaryStore,
      );
      cleanups.push(() => cache.onModuleDestroy());

      // Should not throw; populates and reads from L1 fallback store
      const result = await cache.getOrSet(
        TENANT_A,
        'prefs:u:1',
        120,
        async () => ({ inAppEnabled: true, emailEnabled: false }),
      );
      expect(result).toEqual({ inAppEnabled: true, emailEnabled: false });

      const cachedInL1 = await cache.get(TENANT_A, 'prefs:u:1');
      expect(cachedInL1).toEqual({ inAppEnabled: true, emailEnabled: false });
    });
  });

  describe('RedisCacheStore (ioredis adapter)', () => {
    it('delegates GET, SET EX, SET EX NX, UNLINK, and PING to ioredis', async () => {
      const memory = new Map<string, string>();
      const fakeIoredis = {
        status: 'ready',
        connect: vi.fn().mockResolvedValue(undefined),
        ping: vi.fn().mockResolvedValue('PONG'),
        get: vi.fn(async (key: string) => memory.get(key) ?? null),
        set: vi.fn(
          async (
            key: string,
            val: string,
            _ex: string,
            _ttl: number,
            nx?: string,
          ) => {
            if (nx === 'NX' && memory.has(key)) {
              return null;
            }
            memory.set(key, val);
            return 'OK';
          },
        ),
        unlink: vi.fn(async (...keys: string[]) => {
          let removed = 0;
          for (const k of keys) {
            if (memory.delete(k)) removed += 1;
          }
          return removed;
        }),
        quit: vi.fn().mockResolvedValue('OK'),
        disconnect: vi.fn(),
      } as unknown as Redis;

      const redisStore = new RedisCacheStore({
        url: 'redis://127.0.0.1:6379',
        client: fakeIoredis,
      });

      cleanups.push(() => redisStore.close());

      expect(await redisStore.ping()).toBe(true);
      await redisStore.setRaw('notif:t:1:k1', '{"ok":true}', 60);
      expect(await redisStore.getRaw('notif:t:1:k1')).toBe('{"ok":true}');
      expect(await redisStore.setIfNotExistsRaw('notif:t:1:k1', 'x', 60)).toBe(
        false,
      );
      expect(
        await redisStore.setIfNotExistsRaw('notif:t:1:lock', '1', 60),
      ).toBe(true);
      expect(
        await redisStore.delRaw(['notif:t:1:k1', 'notif:t:1:lock']),
      ).toBe(2);
      expect(await redisStore.getRaw('notif:t:1:k1')).toBeNull();
    });
  });
});
