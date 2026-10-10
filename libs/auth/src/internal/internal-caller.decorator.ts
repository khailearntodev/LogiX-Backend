import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { InternalServiceTokenClaims } from './internal-service-token.js';

export const INTERNAL_CALLER_REQUEST_KEY = 'internalCaller';

/** Extracts the verified internal caller attached by `InternalServiceGuard`. */
export const InternalCaller = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): InternalServiceTokenClaims | undefined =>
    ctx.switchToHttp().getRequest()[INTERNAL_CALLER_REQUEST_KEY],
);
