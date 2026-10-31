import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { BusinessRuleViolationError } from '@logix/errors';
import { TRANSPORT_PREVIEW_TTL_SECONDS } from '@logix/messaging';

const tokenSchema = z.object({
  purpose: z.literal('trip.driver-action.preview'),
  tenantId: z.string().uuid(),
  actorId: z.string().uuid(),
  tripId: z.string().uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  iat: z.number().int(),
  exp: z.number().int(),
});
const issuer = 'logix.transport-service';
const audience = 'logix.driver-action-preview';

export type DriverActionPreviewBinding = {
  tenantId: string;
  actorId: string;
  tripId: string;
  payloadHash: string;
};

@Injectable()
export class DriverActionPreviewTokenService {
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('TRIP_CANCEL_PREVIEW_SECRET');
    if (
      this.secret === config.getOrThrow<string>('JWT_SECRET') ||
      this.secret === config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET')
    )
      throw new Error('Preview secret must be distinct from authentication secrets');
  }

  issue(binding: DriverActionPreviewBinding) {
    const issuedAt = Math.floor(Date.now() / 1000);
    return {
      previewToken: jwt.sign(
        {
          ...binding,
          purpose: 'trip.driver-action.preview',
          iat: issuedAt,
        },
        this.secret,
        {
          algorithm: 'HS256',
          issuer,
          audience,
          expiresIn: TRANSPORT_PREVIEW_TTL_SECONDS,
        },
      ),
      expiresAt: new Date(
        (issuedAt + TRANSPORT_PREVIEW_TTL_SECONDS) * 1000,
      ).toISOString(),
    };
  }

  verify(token: string, expected: DriverActionPreviewBinding) {
    try {
      const claims = tokenSchema.parse(
        jwt.verify(token, this.secret, {
          algorithms: ['HS256'],
          issuer,
          audience,
          maxAge: `${TRANSPORT_PREVIEW_TTL_SECONDS}s`,
        }),
      );
      if (
        claims.exp - claims.iat !== TRANSPORT_PREVIEW_TTL_SECONDS ||
        Object.entries(expected).some(
          ([key, value]) => claims[key as keyof DriverActionPreviewBinding] !== value,
        )
      )
        throw new Error('Driver action preview binding changed');
    } catch {
      throw new BusinessRuleViolationError(
        'DRIVER_ACTION_PREVIEW_EXPIRED_OR_INVALID',
      );
    }
  }
}
