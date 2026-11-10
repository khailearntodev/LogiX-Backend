const SERVICE_PREFIX_PATTERN = /^[a-z][a-z0-9_-]{1,30}$/;
const TENANT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Enforces strict multi-tenant key isolation across all LogiX microservices (`NFR-SEC-001`).
 *
 * Canonical Tenant Key Format:
 *   `{servicePrefix}:t:{tenantId}:{resourceKey}`
 *
 * Example:
 *   `notif:t:01000000-0000-4000-8000-000000000001:u:02000000-0000-4000-8000-000000000002:unread`
 */
export class CacheKeyBuilder {
  private readonly servicePrefix: string;

  constructor(servicePrefix: string) {
    const normalized = servicePrefix.trim();
    if (!SERVICE_PREFIX_PATTERN.test(normalized)) {
      throw new Error(
        `Invalid cache servicePrefix "${servicePrefix}". Must match ${SERVICE_PREFIX_PATTERN.source}`,
      );
    }
    this.servicePrefix = normalized;
  }

  /**
   * Builds a tenant-isolated cache key (`{servicePrefix}:t:{tenantId}:{key}`).
   * Throws immediately if `tenantId` or `key` is blank so cross-tenant cache leaks cannot occur.
   */
  forTenant(tenantId: string, key: string): string {
    const normalizedTenant = tenantId.trim();
    if (!TENANT_ID_PATTERN.test(normalizedTenant)) {
      throw new Error(
        `Invalid tenantId "${tenantId}" for cache key construction`,
      );
    }
    const normalizedKey = key.trim();
    if (!normalizedKey || normalizedKey.includes(' ')) {
      throw new Error(
        `Invalid cache resource key "${key}". Key must be non-empty and contain no spaces`,
      );
    }
    return `${this.servicePrefix}:t:${normalizedTenant}:${normalizedKey}`;
  }

  get prefix(): string {
    return this.servicePrefix;
  }
}

