import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { INTERNAL_CALLERS_KEY } from './allow-internal-callers.decorator.js';
import { INTERNAL_CALLER_REQUEST_KEY } from './internal-caller.decorator.js';
import {
  INTERNAL_SERVICE_TOKEN_HEADER,
  InternalServiceTokenError,
  verifyInternalServiceToken,
} from './internal-service-token.js';

export const INTERNAL_SERVICE_AUTH_OPTIONS = Symbol('INTERNAL_SERVICE_AUTH_OPTIONS');

export interface InternalServiceAuthOptions {
  /** Shared signing secret (min 32 chars), read from config by the host service. */
  secret: string;
  /** Name of the service hosting the guarded endpoints (expected JWT `aud`). */
  serviceName: string;
}

/**
 * Authenticates service-to-service calls. Fails closed: missing header, bad
 * signature, expired token, wrong audience, unlisted caller or missing tenant
 * all yield 401. The host module must provide `INTERNAL_SERVICE_AUTH_OPTIONS`.
 */
@Injectable()
export class InternalServiceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(INTERNAL_SERVICE_AUTH_OPTIONS)
    private readonly options: InternalServiceAuthOptions,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const allowedIssuers =
      this.reflector.getAllAndOverride<string[] | undefined>(INTERNAL_CALLERS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const request = context.switchToHttp().getRequest();
    const header = request.headers?.[INTERNAL_SERVICE_TOKEN_HEADER];
    const token = typeof header === 'string' ? header : undefined;

    if (!token) {
      throw new UnauthorizedException('Thiếu token xác thực nội bộ');
    }

    try {
      request[INTERNAL_CALLER_REQUEST_KEY] = verifyInternalServiceToken(token, {
        secret: this.options.secret,
        audience: this.options.serviceName,
        allowedIssuers,
      });
    } catch (error) {
      if (error instanceof InternalServiceTokenError) {
        throw new UnauthorizedException('Token xác thực nội bộ không hợp lệ');
      }
      throw error;
    }

    return true;
  }
}
