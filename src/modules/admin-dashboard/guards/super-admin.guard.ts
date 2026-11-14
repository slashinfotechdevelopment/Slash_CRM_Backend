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
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.sub) {
      throw new UnauthorizedException('Authentication required.');
    }

    if (user.userType !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Access denied: Super Admin privileges are required to access this dashboard.',
      );
    }

    return true;
  }
}
