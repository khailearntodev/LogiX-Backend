import { SetMetadata } from '@nestjs/common';

export const INTERNAL_CALLERS_KEY = 'internalCallers';

/**
 * Declares which services may call an internal endpoint. Endpoints guarded by
 * `InternalServiceGuard` without this decorator reject every caller.
 */
export const AllowInternalCallers = (...services: string[]) =>
  SetMetadata(INTERNAL_CALLERS_KEY, services);
