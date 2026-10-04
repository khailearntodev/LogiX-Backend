import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator.js';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Nếu endpoint không khai báo yêu cầu quyền cụ thể, cho phép truy cập
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Không xác định được danh tính người dùng');
    }

    // 1. SUPER_ADMIN luôn có toàn quyền trên toàn hệ thống
    if (user.isSuperAdmin === true) {
      return true;
    }

    // 2. OWNER của tổ chức có toàn quyền trong phạm vi tổ chức
    if (user.role === 'OWNER' || user.permissions?.includes('*')) {
      return true;
    }

    // 3. Kiểm tra user có ít nhất một quyền hợp lệ trong danh sách yêu cầu
    const hasPermission = requiredPermissions.some((perm) =>
      user.permissions?.includes(perm),
    );

    if (!hasPermission) {
      throw new ForbiddenException('Bạn không có quyền thực hiện hành động này');
    }

    return true;
  }
}
