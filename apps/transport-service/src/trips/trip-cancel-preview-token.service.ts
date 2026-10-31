import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { BusinessRuleViolationError } from '@logix/errors';

const ISSUER = 'logix.transport-service';
const AUDIENCE = 'logix.trip-cancel-preview';
const PURPOSE = 'trip.cancel.preview';
const ACTION = 'CANCEL';
export const TRIP_CANCEL_PREVIEW_TTL_SECONDS = 300;

export interface TripCancelPreviewBinding {
  tenantId: string;
  actorId: string;
  tripId: string;
  expectedVersion: number;
  membershipHash: string;
}

export interface TripCancelPreviewClaims
  extends JwtPayload, TripCancelPreviewBinding {
  purpose: typeof PURPOSE;
  action: typeof ACTION;
  tokenVersion: 1;
}

@Injectable()
export class TripCancelPreviewTokenService {
  private readonly secret: Buffer;

  constructor(config: ConfigService) {
    const previewSecret = config.getOrThrow<string>(
      'TRIP_CANCEL_PREVIEW_SECRET',
    );
    if (
      previewSecret === config.getOrThrow<string>('JWT_SECRET') ||
      previewSecret === config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET')
    ) {
      throw new Error(
        'TRIP_CANCEL_PREVIEW_SECRET must be distinct from user and internal JWT secrets',
      );
    }
    this.secret = Buffer.from(previewSecret, 'utf8');
  }

  issue(binding: TripCancelPreviewBinding) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        ...binding,
        purpose: PURPOSE,
        action: ACTION,
        tokenVersion: 1,
        iat: issuedAt,
      },
      this.secret,
      {
        algorithm: 'HS256',
        issuer: ISSUER,
        audience: AUDIENCE,
        expiresIn: TRIP_CANCEL_PREVIEW_TTL_SECONDS,
      },
    );
    const claims = jwt.decode(token) as JwtPayload;
    if (typeof claims.exp !== 'number') {
      throw new Error('Signed cancellation preview is missing expiry');
    }
    return { token, expiresAt: new Date(claims.exp * 1000) };
  }

  verify(token: string): TripCancelPreviewClaims {
    try {
      const claims = jwt.verify(token, this.secret, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
        maxAge: `${TRIP_CANCEL_PREVIEW_TTL_SECONDS}s`,
      });
      if (
        typeof claims === 'string' ||
        claims.purpose !== PURPOSE ||
        claims.action !== ACTION ||
        claims.tokenVersion !== 1 ||
        typeof claims.tenantId !== 'string' ||
        typeof claims.actorId !== 'string' ||
        typeof claims.tripId !== 'string' ||
        typeof claims.expectedVersion !== 'number' ||
        !Number.isSafeInteger(claims.expectedVersion) ||
        claims.expectedVersion <= 0 ||
        typeof claims.membershipHash !== 'string' ||
        typeof claims.iat !== 'number' ||
        typeof claims.exp !== 'number' ||
        claims.exp - claims.iat !== TRIP_CANCEL_PREVIEW_TTL_SECONDS
      ) {
        throw new Error('Invalid cancellation preview claims');
      }
      return claims as TripCancelPreviewClaims;
    } catch {
      throw new BusinessRuleViolationError(
        'CANCEL_PREVIEW_EXPIRED_OR_INVALID',
        {
          action: 'refreshPreview',
        },
      );
    }
  }
}
