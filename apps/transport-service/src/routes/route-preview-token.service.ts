import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { BusinessRuleViolationError } from '@logix/errors';
import { TRANSPORT_PREVIEW_TTL_SECONDS } from '@logix/messaging';

const claimsSchema = z.object({
  purpose: z.literal('trip.route.preview'), action: z.enum(['APPROVE', 'OVERRIDE', 'DISPATCH']),
  tenantId: z.string().uuid(), actorId: z.string().uuid(), tripId: z.string().uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  iat: z.number().int(), exp: z.number().int(),
});
const issuer = 'logix.transport-service';
const audience = 'logix.trip-route-preview';
type Binding = Pick<z.infer<typeof claimsSchema>, 'action' | 'tenantId' | 'actorId' | 'tripId' | 'payloadHash'>;

@Injectable()
export class RoutePreviewTokenService {
  private readonly secret: string;
  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('TRIP_CANCEL_PREVIEW_SECRET');
    if (this.secret === config.getOrThrow<string>('JWT_SECRET') ||
      this.secret === config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET'))
      throw new Error('Preview secret must be distinct from authentication secrets');
  }
  issue(binding: Binding) {
    const issuedAt = Math.floor(Date.now() / 1000);
    return {
      previewToken: jwt.sign({ ...binding, purpose: 'trip.route.preview', iat: issuedAt }, this.secret, {
        algorithm: 'HS256', issuer, audience, expiresIn: TRANSPORT_PREVIEW_TTL_SECONDS,
      }),
      expiresAt: new Date((issuedAt + TRANSPORT_PREVIEW_TTL_SECONDS) * 1000).toISOString(),
    };
  }
  verify(token: string, expected: Binding) {
    try {
      const claims = claimsSchema.parse(jwt.verify(token, this.secret, {
        algorithms: ['HS256'], issuer, audience, maxAge: `${TRANSPORT_PREVIEW_TTL_SECONDS}s`,
      }));
      if (claims.exp - claims.iat !== TRANSPORT_PREVIEW_TTL_SECONDS ||
        Object.entries(expected).some(([key, value]) => claims[key as keyof Binding] !== value))
        throw new Error('Preview binding changed');
    } catch {
      throw new BusinessRuleViolationError('ROUTE_PREVIEW_EXPIRED_OR_INVALID');
    }
  }
}
