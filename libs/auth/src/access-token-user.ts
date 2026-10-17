import { UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedUser, JwtPayload } from './interfaces/jwt-payload.interface.js';

/** Maps verified access-token claims; signature and expiry are checked by Passport. */
export function accessTokenUser(payload: JwtPayload): AuthenticatedUser {
  if (
    !payload ||
    payload.jti !== undefined ||
    typeof payload.sub !== 'string' || !payload.sub.trim() ||
    typeof payload.tenantId !== 'string' || !payload.tenantId.trim() ||
    typeof payload.email !== 'string' ||
    (payload.role !== undefined && typeof payload.role !== 'string') ||
    (payload.isSuperAdmin !== undefined && typeof payload.isSuperAdmin !== 'boolean') ||
    (payload.permissions !== undefined && (
      !Array.isArray(payload.permissions) ||
      !payload.permissions.every((permission) => typeof permission === 'string')
    ))
  ) {
    throw new UnauthorizedException('Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
  }

  return {
    id: payload.sub,
    email: payload.email,
    tenantId: payload.tenantId,
    role: payload.role,
    isSuperAdmin: payload.isSuperAdmin === true,
    permissions: payload.permissions ?? [],
  };
}
