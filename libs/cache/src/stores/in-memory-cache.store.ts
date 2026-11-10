import type { CacheStore } from '../cache.interfaces.js';

interface MemoryEntry {
  value: string;
  expiresAtMs: number;
}

/**
 * Bounded LRU + TTL In-Memory Cache Store (L1 Fallback / Test store).
 *
 * Used automatically when `REDIS_URL` is not configured (e.g. unit tests) or
 * as a fail-open safety buffer if the Redis cluster experiences transient downtime.
 */
export class InMemoryCacheStore implements CacheStore {
  private readonly store = new Map<string, MemoryEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 2_000) {
    this.maxEntries = Math.max(50, maxEntries);
  }

  async getRaw(fullKey: string): Promise<string | null> {
    const entry = this.store.get(fullKey);
    if (!entry) {
      return null;
    }
    if (Date.now() >= entry.expiresAtMs) {
      this.store.delete(fullKey);
      return null;
    }
    // Refresh insertion order for LRU behavior
    this.store.delete(fullKey);
    this.store.set(fullKey, entry);
    return entry.value;
  }

  async setRaw(
    fullKey: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    const validTtlSeconds = Math.max(1, Math.floor(ttlSeconds));
    if (this.store.has(fullKey)) {
      this.store.delete(fullKey);
    } else if (this.store.size >= this.maxEntries) {
      this.evictOldest();
    }
    this.store.set(fullKey, {
      value,
      expiresAtMs: Date.now() + validTtlSeconds * 1_000,
    });
  }

  async setIfNotExistsRaw(
    fullKey: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const current = await this.getRaw(fullKey);
    if (current !== null) {
      return false;
    }
    await this.setRaw(fullKey, value, ttlSeconds);
    return true;
  }

  async delRaw(fullKeys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of fullKeys) {
      if (this.store.delete(key)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.store.clear();
  }

  private evictOldest(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now >= entry.expiresAtMs) {
        this.store.delete(key);
        return;
      }
    }
    const oldestKey = this.store.keys().next().value;
    if (oldestKey !== undefined) {
      this.store.delete(oldestKey);
    }
  }
}

