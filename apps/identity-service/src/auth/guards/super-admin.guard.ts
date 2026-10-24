import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<{
      user?: { isSuperAdmin?: unknown };
    }>();
    if (!user) {
      throw new UnauthorizedException();
    }
    if (user.isSuperAdmin !== true) {
      throw new ForbiddenException();
    }
    return true;
  }
}
