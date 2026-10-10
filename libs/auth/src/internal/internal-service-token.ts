import jwt from 'jsonwebtoken';

/** Header carrying the service-to-service token (kept separate from user `Authorization`). */
export const INTERNAL_SERVICE_TOKEN_HEADER = 'x-internal-service-token';

const INTERNAL_TOKEN_ALGORITHM = 'HS256';
const INTERNAL_TOKEN_TYPE = 'internal-service';
const MIN_SECRET_LENGTH = 32;
const MAX_TTL_SECONDS = 300;

export interface InternalServiceTokenClaims {
  /** Calling service name (JWT `iss`). */
  service: string;
  /** Target service name (JWT `aud`). */
  audience: string;
  tenantId: string;
}

export interface SignInternalServiceTokenOptions extends InternalServiceTokenClaims {
  secret: string;
  ttlSeconds: number;
}

export interface VerifyInternalServiceTokenOptions {
  secret: string;
  audience: string;
  allowedIssuers: readonly string[];
}

export class InternalServiceTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalServiceTokenError';
  }
}

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new InternalServiceTokenError(
      `Internal service secret must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InternalServiceTokenError(`Internal service token is missing "${field}"`);
  }
}

export function signInternalServiceToken(options: SignInternalServiceTokenOptions): string {
  assertSecret(options.secret);
  assertNonEmpty(options.service, 'service');
  assertNonEmpty(options.audience, 'audience');
  assertNonEmpty(options.tenantId, 'tenantId');
  if (
    !Number.isInteger(options.ttlSeconds) ||
    options.ttlSeconds <= 0 ||
    options.ttlSeconds > MAX_TTL_SECONDS
  ) {
    throw new InternalServiceTokenError(
      `Internal service token TTL must be an integer between 1 and ${MAX_TTL_SECONDS} seconds`,
    );
  }

  return jwt.sign({ typ: INTERNAL_TOKEN_TYPE, tenantId: options.tenantId }, options.secret, {
    algorithm: INTERNAL_TOKEN_ALGORITHM,
    issuer: options.service,
    audience: options.audience,
    expiresIn: options.ttlSeconds,
  });
}

export function verifyInternalServiceToken(
  token: string,
  options: VerifyInternalServiceTokenOptions,
): InternalServiceTokenClaims {
  assertSecret(options.secret);
  assertNonEmpty(token, 'token');
  if (options.allowedIssuers.length === 0) {
    throw new InternalServiceTokenError('No internal caller is allowed for this endpoint');
  }

  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, options.secret, {
      algorithms: [INTERNAL_TOKEN_ALGORITHM],
      audience: options.audience,
      issuer: [...options.allowedIssuers] as [string, ...string[]],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid token';
    throw new InternalServiceTokenError(`Internal service token rejected: ${reason}`);
  }

  if (typeof decoded === 'string' || decoded.typ !== INTERNAL_TOKEN_TYPE) {
    throw new InternalServiceTokenError('Internal service token has an unexpected type');
  }
  if (typeof decoded.exp !== 'number') {
    throw new InternalServiceTokenError('Internal service token must expire');
  }
  assertNonEmpty(decoded.iss, 'iss');
  assertNonEmpty(decoded.tenantId, 'tenantId');

  return { service: decoded.iss, audience: options.audience, tenantId: decoded.tenantId };
}
