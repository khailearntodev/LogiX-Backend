import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { signInternalServiceToken } from '@logix/auth';
import { ServiceId } from '@logix/common';
import type { NotificationAudience } from '../events/notification-draft.js';

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

  async resolve(tenantId: string, audience: NotificationAudience): Promise<string[]> {
    const requestBody =
      audience.kind === 'USERS'
        ? { kind: 'USERS', userIds: [...new Set(audience.userIds)] }
        : audience;

    if (requestBody.kind === 'USERS' && requestBody.userIds.length === 0) {
      return [];
    }

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
      const response = await fetch(`${this.baseUrl}/api/v1/internal/recipients/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-token': token,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Identity recipient resolution failed with HTTP ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('userIds' in payload) ||
        !Array.isArray(payload.userIds) ||
        payload.userIds.some((userId) => typeof userId !== 'string')
      ) {
        throw new Error('Identity recipient response is invalid');
      }
      return [...new Set(payload.userIds)];
    } finally {
      clearTimeout(timeout);
    }
  }
}
