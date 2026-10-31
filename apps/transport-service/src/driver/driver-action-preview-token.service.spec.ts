import { randomBytes, randomUUID } from 'node:crypto';
import { BusinessRuleViolationError } from '@logix/errors';
import type { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { DriverActionPreviewTokenService } from './driver-action-preview-token.service.js';

describe('Driver action preview tokens', () => {
  const secret = randomBytes(32).toString('hex');
  const binding = () => ({
    tenantId: randomUUID(),
    actorId: randomUUID(),
    tripId: randomUUID(),
    payloadHash: randomBytes(32).toString('hex'),
  });
  const service = (
    secretValue = secret,
    jwtSecret = randomBytes(32).toString('hex'),
    internalSecret = randomBytes(32).toString('hex'),
  ) =>
    new DriverActionPreviewTokenService({
      getOrThrow: vi.fn(
        (key: string) =>
          ({
            TRIP_CANCEL_PREVIEW_SECRET: secretValue,
            JWT_SECRET: jwtSecret,
            INTERNAL_SERVICE_JWT_SECRET: internalSecret,
          })[key],
      ),
    } as unknown as ConfigService);

  it('issues and verifies the purpose-separated signed binding with the accepted TTL', () => {
    const tokens = service();
    const expected = binding();
    const before = Date.now();
    const issued = tokens.issue(expected);

    tokens.verify(issued.previewToken, expected);
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThanOrEqual(
      before + 299_000,
    );
    expect(new Date(issued.expiresAt).getTime()).toBeLessThanOrEqual(
      before + 301_000,
    );
  });

  it.each([
    ['tenant', 'tenantId'],
    ['actor', 'actorId'],
    ['trip', 'tripId'],
    ['payload', 'payloadHash'],
  ] as const)('rejects a token bound to another %s', (_label, field) => {
    const tokens = service();
    const expected = binding();
    const issued = tokens.issue(expected);
    const different = {
      ...expected,
      [field]:
        field === 'payloadHash'
          ? randomBytes(32).toString('hex')
          : randomUUID(),
    };

    expect(() =>
      tokens.verify(issued.previewToken, different),
    ).toThrow(BusinessRuleViolationError);
  });

  it('rejects an expired token and tokens signed for another purpose', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const tokens = service();
    const expected = binding();
    const issued = tokens.issue(expected);
    vi.setSystemTime(new Date('2026-10-26T12:05:01.000Z'));
    expect(() =>
      tokens.verify(issued.previewToken, expected),
    ).toThrow(BusinessRuleViolationError);
    vi.useRealTimers();

    const issuedAt = Math.floor(Date.now() / 1000);
    const wrongPurpose = jwt.sign(
      {
        ...expected,
        purpose: 'trip.cancel.preview',
        iat: issuedAt,
      },
      secret,
      {
        algorithm: 'HS256',
        issuer: 'logix.transport-service',
        audience: 'logix.driver-action-preview',
        expiresIn: 300,
      },
    );
    expect(() =>
      tokens.verify(wrongPurpose, expected),
    ).toThrow(BusinessRuleViolationError);
  });

  it('fails fast when the preview key is reused for an authentication token', () => {
    expect(() => service(secret, secret)).toThrow(
      'Preview secret must be distinct from authentication secrets',
    );
    expect(() =>
      service(secret, randomBytes(32).toString('hex'), secret),
    ).toThrow('Preview secret must be distinct from authentication secrets');
  });
});
