/**
 * @logix/auth — Shared authentication & authorization library for LogiX Backend.
 *
 * Provides:
 * - Decorators: `@RequirePermissions(...)`, `@CurrentUser()`
 * - Guards: `PermissionsGuard`, `JwtAuthGuard`
 * - Interfaces: `JwtPayload`, `AuthenticatedUser`
 */

export * from './decorators/permissions.decorator.js';
export * from './decorators/current-user.decorator.js';
export * from './guards/permissions.guard.js';
export * from './guards/jwt-auth.guard.js';
export * from './interfaces/jwt-payload.interface.js';
