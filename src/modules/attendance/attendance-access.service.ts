import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { UsersService } from '../users/users.service';
import { DataScope, PermissionEffect, RecordStatus } from '../../generated/prisma/enums';

@Injectable()
export class AttendanceAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Enforces data scope rules for an actor accessing or managing a target user's attendance data.
   * - If actor is accessing their own data (actorUserId === targetUserId), access is permitted.
   * - If actor is accessing another user's data:
   *   - Resolves effective DataScope for the specified permissionCode.
   *   - ALL: Full tenant access.
   *   - DEPARTMENT: Permitted only if actor and target share at least one department.
   *   - ASSIGNED: Permitted only if target reports to actor (reportingToId === actorUserId).
   *   - OWN: Denied when accessing another user's records.
   */
  async assertSupervisorAccess(
    targetUserId: string,
    actorUserId: string,
    actorUserType: string,
    permissionCode: string,
  ): Promise<void> {
    // 1. Employee accessing their own records is always permitted
    if (actorUserId === targetUserId) {
      return;
    }

    // 2. Resolve actor's data scope for the requested permission
    const scope = await this.usersService.resolveActorDataScope(
      actorUserId,
      actorUserType,
      permissionCode,
    );

    if (scope === DataScope.ALL) {
      return;
    }

    if (scope === DataScope.DEPARTMENT) {
      const actorDepts = await this.prisma.userDepartment.findMany({
        where: { userId: actorUserId },
        select: { departmentId: true },
      });
      const actorDeptIds = actorDepts.map((d) => d.departmentId);

      if (actorDeptIds.length === 0) {
        throw new ForbiddenException(
          'Access denied: You are not assigned to any department.',
        );
      }

      const targetInDept = await this.prisma.userDepartment.findFirst({
        where: {
          userId: targetUserId,
          departmentId: { in: actorDeptIds },
        },
      });

      if (!targetInDept) {
        throw new ForbiddenException(
          'Access denied: Target employee is not within your department.',
        );
      }
      return;
    }

    if (scope === DataScope.ASSIGNED) {
      const targetProfile = await this.prisma.employeeProfile.findUnique({
        where: { userId: targetUserId },
        select: { reportingToId: true },
      });

      if (!targetProfile) {
        throw new NotFoundException('Target employee profile not found.');
      }

      if (targetProfile.reportingToId !== actorUserId) {
        throw new ForbiddenException(
          'Access denied: Target employee does not report to you.',
        );
      }
      return;
    }

    // Scope === OWN: Cannot access other users' attendance data
    throw new ForbiddenException(
      'Access denied: You only have permission to view your own attendance data.',
    );
  }

  /**
   * Enforces that an actor cannot approve or review their own request (Anti-Self-Approval invariant).
   */
  assertNotSelfAction(
    targetUserId: string,
    actorUserId: string,
    actionDescription: string = 'approve your own request',
  ): void {
    if (actorUserId === targetUserId) {
      throw new ForbiddenException(
        `Anti-self-approval violation: You cannot ${actionDescription}.`,
      );
    }
  }

  /**
   * Checks whether an actor has a specific permission via role mapping or direct user permission.
   */
  async hasPermission(
    userId: string,
    userType: string,
    permissionCode: string,
  ): Promise<boolean> {
    if (userType === 'SUPER_ADMIN') {
      return true;
    }

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

    let hasAllow = false;
    for (const ur of userRoles) {
      if (ur.role.status === RecordStatus.ACTIVE && !ur.role.deletedAt) {
        for (const rp of ur.role.permissions) {
          if (
            rp.permission.status === RecordStatus.ACTIVE &&
            rp.permission.code === permissionCode
          ) {
            hasAllow = true;
            break;
          }
        }
      }
      if (hasAllow) break;
    }

    const directPermission = await this.prisma.userPermission.findFirst({
      where: {
        userId,
        permission: { code: permissionCode, status: RecordStatus.ACTIVE },
      },
    });

    if (directPermission) {
      if (directPermission.effect === PermissionEffect.DENY) {
        return false;
      }
      if (directPermission.effect === PermissionEffect.ALLOW) {
        return true;
      }
    }

    return hasAllow;
  }
}

