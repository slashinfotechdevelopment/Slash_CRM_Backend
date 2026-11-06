import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../database/prisma.service';
import {
  PERMISSIONS_KEY,
  REQUIRE_ANY_PERMISSIONS_KEY,
} from '../decorators/require-permissions.decorator';
import { PermissionEffect, RecordStatus } from '../../generated/prisma/enums';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    const requireAnyPermissions = this.reflector.getAllAndOverride<string[]>(
      REQUIRE_ANY_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    const hasRequired = requiredPermissions && requiredPermissions.length > 0;
    const hasRequireAny = requireAnyPermissions && requireAnyPermissions.length > 0;

    if (!hasRequired && !hasRequireAny) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.sub) {
      throw new UnauthorizedException('Authentication required.');
    }

    // Super Admin has full unrestricted system access
    if (user.userType === 'SUPER_ADMIN') {
      return true;
    }

    const userPermissions = await this.resolveEffectivePermissions(user.sub);

    if (hasRequired) {
      const hasAll = requiredPermissions.every((perm) =>
        userPermissions.has(perm),
      );
      if (!hasAll) {
        throw new ForbiddenException(
          `Insufficient permissions. Required: [${requiredPermissions.join(', ')}]`,
        );
      }
    }

    if (hasRequireAny) {
      const hasAny = requireAnyPermissions.some((perm) =>
        userPermissions.has(perm),
      );
      if (!hasAny) {
        throw new ForbiddenException(
          `Insufficient permissions. At least one required: [${requireAnyPermissions.join(', ')}]`,
        );
      }
    }

    return true;
  }

  private async resolveEffectivePermissions(userId: string): Promise<Set<string>> {
    // 1. Role-based permissions
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: {
        role: {
          include: {
            permissions: {
              include: { permission: true },
            },
          },
        },
      },
    });

    const permissionSet = new Set<string>();
    for (const ur of userRoles) {
      if (ur.role.status === RecordStatus.ACTIVE && !ur.role.deletedAt) {
        for (const rp of ur.role.permissions) {
          if (rp.permission.status === RecordStatus.ACTIVE) {
            permissionSet.add(rp.permission.code);
          }
        }
      }
    }

    // 2. Direct user overrides (DENY overrides ALLOW)
    const directPermissions = await this.prisma.userPermission.findMany({
      where: { userId },
      include: { permission: true },
    });

    for (const dp of directPermissions) {
      if (dp.permission.status === RecordStatus.ACTIVE) {
        if (dp.effect === PermissionEffect.DENY) {
          permissionSet.delete(dp.permission.code);
        } else if (dp.effect === PermissionEffect.ALLOW) {
          permissionSet.add(dp.permission.code);
        }
      }
    }

    return permissionSet;
  }
}

