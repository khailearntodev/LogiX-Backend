import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { signInternalServiceToken } from '@logix/auth';
import { ServiceId } from '@logix/common';
import type { NotificationAudience } from '../events/notification-draft.js';

export interface ResolveRecipientsPageOptions {
  limit?: number;
  cursor?: string | null;
  snapshotAt?: string | null;
}

export interface ResolveRecipientsPageResult {
  userIds: string[];
  nextCursor: string | null;
  hasMore: boolean;
}

@Injectable()
export class IdentityRecipientClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('IDENTITY_SERVICE_URL').replace(/\/$/, '');
    this.secret = config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET');
    this.timeoutMs = config.getOrThrow<number>('IDENTITY_REQUEST_TIMEOUT_MS');
  }

  async resolve(
    tenantId: string,
    audience: NotificationAudience,
    options?: { pageSize?: number; snapshotAt?: string },
  ): Promise<string[]> {
    const normalized = this.normalizeAudience(audience);
    if (this.isEmptyListAudience(normalized)) {
      return [];
    }

    const snapshotAt = options?.snapshotAt ?? new Date().toISOString();
    const collected = new Set<string>();
    let cursor: string | null = null;
    let hasMore = false;

    do {
      const page = await this.resolvePage(tenantId, normalized, {
        limit: options?.pageSize,
        cursor,
        snapshotAt,
      });
      for (const userId of page.userIds) {
        collected.add(userId);
      }
      hasMore = page.hasMore;
      if (hasMore) {
        if (!page.nextCursor || page.nextCursor === cursor) {
          throw new Error('Identity recipient pagination cursor did not advance');
        }
        cursor = page.nextCursor;
      }
    } while (hasMore);

    return [...collected];
  }

  async resolvePage(
    tenantId: string,
    audience: NotificationAudience,
    options: ResolveRecipientsPageOptions = {},
  ): Promise<ResolveRecipientsPageResult> {
    const normalized = this.normalizeAudience(audience);
    if (this.isEmptyListAudience(normalized)) {
      return { userIds: [], nextCursor: null, hasMore: false };
    }

    const requestBody: Record<string, unknown> = {
      audience: normalized,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.snapshotAt !== undefined
        ? { snapshotAt: options.snapshotAt }
        : {}),
    };

    const token = signInternalServiceToken({
      service: ServiceId.NOTIFICATION_SERVICE,
      audience: ServiceId.IDENTITY_SERVICE,
      tenantId,
      secret: this.secret,
      ttlSeconds: 60,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(
        `${this.baseUrl}/api/v1/internal/recipients/resolve`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-service-token': token,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(
          `Identity recipient resolution failed with HTTP ${response.status}`,
        );
      }

      const payload: unknown = await response.json();
      if (!isValidResolveResponse(payload)) {
        throw new Error('Identity recipient response is invalid');
      }

      return {
        userIds: [...new Set(payload.userIds)],
        nextCursor: payload.nextCursor,
        hasMore: payload.hasMore,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeAudience(audience: NotificationAudience): NotificationAudience {
    if (audience.kind === 'USERS') {
      return { kind: 'USERS', userIds: [...new Set(audience.userIds)] };
    }
    if (audience.kind === 'ROLES') {
      return { kind: 'ROLES', roleIds: [...new Set(audience.roleIds)] };
    }
    return audience;
  }

  private isEmptyListAudience(audience: NotificationAudience): boolean {
    return (
      (audience.kind === 'USERS' && audience.userIds.length === 0) ||
      (audience.kind === 'ROLES' && audience.roleIds.length === 0)
    );
  }
}

function isValidResolveResponse(
  payload: unknown,
): payload is ResolveRecipientsPageResult {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Record<string, unknown>;
  if (
    !Array.isArray(candidate.userIds) ||
    candidate.userIds.some((userId) => typeof userId !== 'string')
  ) {
    return false;
  }
  if (typeof candidate.hasMore !== 'boolean') return false;
  if (candidate.nextCursor !== null && typeof candidate.nextCursor !== 'string') {
    return false;
  }
  if (
    candidate.hasMore &&
    (typeof candidate.nextCursor !== 'string' || !candidate.nextCursor)
  ) {
    return false;
  }
  return true;
}
