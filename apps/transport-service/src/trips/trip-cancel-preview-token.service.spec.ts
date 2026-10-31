import { randomBytes, randomUUID } from 'node:crypto';
import { BusinessRuleViolationError } from '@logix/errors';
import type { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { TripCancelPreviewTokenService } from './trip-cancel-preview-token.service.js';

describe('Trip cancellation preview tokens', () => {
  const secret = randomBytes(32).toString('hex');
  const binding = () => ({
    tenantId: randomUUID(),
    actorId: randomUUID(),
    tripId: randomUUID(),
    expectedVersion: 4,
    membershipHash: randomBytes(32).toString('hex'),
  });
  const service = (
    secretValue = secret,
    jwtSecret = randomBytes(32).toString('hex'),
    internalSecret = randomBytes(32).toString('hex'),
  ) =>
    new TripCancelPreviewTokenService({
      getOrThrow: vi.fn(
        (key: string) =>
          ({
            TRIP_CANCEL_PREVIEW_SECRET: secretValue,
            JWT_SECRET: jwtSecret,
            INTERNAL_SERVICE_JWT_SECRET: internalSecret,
          })[key],
      ),
    } as unknown as ConfigService);

  it('issues a signed token with the exact five-minute expiry and verifies its binding', () => {
    const tokens = service();
    const input = binding();
    const now = Date.now();
    const issued = tokens.issue(input);

    expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(now + 299_000);
    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(now + 301_000);
    expect(tokens.verify(issued.token)).toMatchObject({
      ...input,
      purpose: 'trip.cancel.preview',
      action: 'CANCEL',
      tokenVersion: 1,
    });
  });

  it.each([
    [
      'tampered payload',
      (token: string) => {
        const [header, payload, signature] = token.split('.');
        const alteredPayload = `${payload[0] === 'a' ? 'b' : 'a'}${payload.slice(1)}`;
        return `${header}.${alteredPayload}.${signature}`;
      },
    ],
    ['different signing secret', (token: string) => token],
  ])('rejects %s', (description, mutate) => {
    const token = service().issue(binding()).token;
    const verifier =
      description === 'different signing secret'
        ? service(randomBytes(32).toString('hex'))
        : service();
    expect(() => verifier.verify(mutate(token))).toThrow(
      BusinessRuleViolationError,
    );
  });

  it('rejects a token after its expiry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
    const tokens = service();
    const issued = tokens.issue(binding());
    vi.setSystemTime(new Date('2026-10-25T12:05:01.000Z'));

    expect(() => tokens.verify(issued.token)).toThrow(
      BusinessRuleViolationError,
    );
    vi.useRealTimers();
  });

  it('rejects a correctly signed token for another purpose', () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        ...binding(),
        purpose: 'shipment.cancel.preview',
        action: 'CANCEL',
        tokenVersion: 1,
        iat: issuedAt,
      },
      secret,
      {
        algorithm: 'HS256',
        issuer: 'logix.transport-service',
        audience: 'logix.trip-cancel-preview',
        expiresIn: 300,
      },
    );

    expect(() => service().verify(token)).toThrow(BusinessRuleViolationError);
  });

  it('fails fast when the preview secret is reused for another JWT purpose', () => {
    expect(() => service(secret, secret)).toThrow(
      'TRIP_CANCEL_PREVIEW_SECRET must be distinct',
    );
    expect(() =>
      service(secret, randomBytes(32).toString('hex'), secret),
    ).toThrow('TRIP_CANCEL_PREVIEW_SECRET must be distinct');
  });
});
