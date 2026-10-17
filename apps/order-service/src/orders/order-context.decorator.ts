import { randomUUID } from 'node:crypto';
import {
  createParamDecorator,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { AuthenticatedUser } from '@logix/auth';
import type { Request } from 'express';
import { extractAccessToken } from '../auth/access-token.extractor.js';
import { CORRELATION_ID_HEADER } from './domain/order-constants.js';
import type { OrderCommandContext } from './order.types.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Correlation ids are stored in UUID columns; foreign formats start a new trace. */
function resolveCorrelationId(request: Request): string {
  const header = request.headers[CORRELATION_ID_HEADER];
  return typeof header === 'string' && UUID_PATTERN.test(header)
    ? header
    : randomUUID();
}

/**
 * Builds the command context from an already authenticated request. Must be
 * used behind JwtAuthGuard; a missing user or token means a wiring error.
 */
export const OrderContext = createParamDecorator(
  (_data: unknown, executionContext: ExecutionContext): OrderCommandContext => {
    const request = executionContext
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const token = extractAccessToken(request);
    if (!request.user || !token) {
      throw new UnauthorizedException(
        'Phiên đăng nhập không hợp lệ hoặc đã hết hạn',
      );
    }
    return {
      tenantId: request.user.tenantId,
      actorId: request.user.id,
      correlationId: resolveCorrelationId(request),
      authorization: `Bearer ${token}`,
    };
  },
);
