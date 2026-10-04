import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Decorator yêu cầu một hoặc nhiều quyền để truy cập endpoint.
 *
 * @param permissions Danh sách mã quyền theo định dạng `module:resource:action`
 * @example
 * ```typescript
 * @RequirePermissions('inventory:stock:read')
 * @Get('balances')
 * listBalances() { ... }
 * ```
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
