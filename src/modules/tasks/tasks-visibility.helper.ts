import { Prisma } from '../../generated/prisma/client';
import { DataScope } from '../../generated/prisma/enums';

export interface TaskActorContext {
  userId: string;
  userType: string; // 'SUPER_ADMIN' | 'ADMIN' | 'EMPLOYEE' | 'CLIENT'
  departmentIds: string[];
  subordinateUserIds: string[];
  effectiveDataScope: DataScope;
}

/**
 * Builds the strict Prisma WHERE clause enforcing user-type ceilings and data scopes.
 * Implements the approved Phase 6.3.1 design:
 * - Ceiling is an independent upper bound on assignee user type.
 * - Creator ownership never overrides the ceiling or expands scope.
 * - Department scope strictly enforces authorized departments.
 * - Default deny for invalid or client contexts.
 */
export function buildTaskVisibilityWhere(actor: TaskActorContext): Prisma.TaskWhereInput {
  // 1. DEFAULT DENY: Invalid or unauthenticated context
  if (!actor || !actor.userId || !actor.userType) {
    return { id: 'FORBIDDEN_INVALID_CONTEXT' };
  }

  // 2. CLIENT BOUNDARY: Excluded from internal task management in this release
  if (actor.userType === 'CLIENT') {
    return { id: 'FORBIDDEN_CLIENT_TASK_ACCESS_NOT_SUPPORTED' };
  }

  // 3. SUPER ADMIN: Unrestricted ceiling across all scopes
  if (actor.userType === 'SUPER_ADMIN') {
    switch (actor.effectiveDataScope) {
      case DataScope.ALL:
        return { deletedAt: null };

      case DataScope.DEPARTMENT:
        if (!actor.departmentIds || actor.departmentIds.length === 0) {
          return { id: 'FORBIDDEN_NO_DEPARTMENTS' };
        }
        return {
          deletedAt: null,
          departmentId: { in: actor.departmentIds },
        };

      case DataScope.ASSIGNED:
        return {
          deletedAt: null,
          OR: [
            { assigneeId: actor.userId },
            { assigneeId: { in: actor.subordinateUserIds } },
            { createdById: actor.userId, assigneeId: null },
          ],
        };

      case DataScope.OWN:
        return {
          deletedAt: null,
          OR: [
            { assigneeId: actor.userId },
            { createdById: actor.userId, assigneeId: null },
          ],
        };

      default:
        return { id: 'FORBIDDEN_UNSUPPORTED_SCOPE' };
    }
  }

  // 4. ADMIN: Supervises ADMIN and EMPLOYEE tasks
  if (actor.userType === 'ADMIN') {
    const adminCeiling: Prisma.TaskWhereInput = {
      OR: [
        {
          assignee: {
            userType: {
              code: { in: ['EMPLOYEE', 'ADMIN'] },
            },
          },
        },
        {
          assigneeId: null,
        },
      ],
    };

    let adminScopeFilter: Prisma.TaskWhereInput;
    switch (actor.effectiveDataScope) {
      case DataScope.ALL:
        adminScopeFilter = {};
        break;

      case DataScope.DEPARTMENT:
        if (!actor.departmentIds || actor.departmentIds.length === 0) {
          return { id: 'FORBIDDEN_NO_DEPARTMENTS' };
        }
        adminScopeFilter = {
          departmentId: { in: actor.departmentIds },
        };
        break;

      case DataScope.ASSIGNED:
        return {
          AND: [
            { deletedAt: null },
            adminCeiling,
            {
              OR: [
                { assigneeId: actor.userId },
                { assigneeId: { in: actor.subordinateUserIds } },
                { createdById: actor.userId, assigneeId: null },
              ],
            },
          ],
        };

      case DataScope.OWN:
        adminScopeFilter = {
          OR: [
            { assigneeId: actor.userId },
            { createdById: actor.userId, assigneeId: null },
          ],
        };
        break;

      default:
        return { id: 'FORBIDDEN_UNSUPPORTED_SCOPE' };
    }

    return {
      AND: [
        { deletedAt: null },
        adminCeiling,
        adminScopeFilter,
      ],
    };
  }

  // 5. EMPLOYEE: Base view is own tasks; elevated by authorized dynamic roles
  if (actor.userType === 'EMPLOYEE') {
    const employeeCeiling: Prisma.TaskWhereInput = {
      OR: [
        {
          assignee: {
            userType: {
              code: 'EMPLOYEE',
            },
          },
        },
        {
          assigneeId: null,
        },
      ],
    };

    let employeeScopeFilter: Prisma.TaskWhereInput;
    switch (actor.effectiveDataScope) {
      case DataScope.OWN:
        employeeScopeFilter = {
          OR: [
            { assigneeId: actor.userId },
            { createdById: actor.userId, assigneeId: null },
          ],
        };
        break;

      case DataScope.ASSIGNED:
        return {
          AND: [
            { deletedAt: null },
            employeeCeiling,
            {
              OR: [
                { assigneeId: actor.userId },
                { assigneeId: { in: actor.subordinateUserIds } },
                { createdById: actor.userId, assigneeId: null },
              ],
            },
          ],
        };

      case DataScope.DEPARTMENT:
        if (!actor.departmentIds || actor.departmentIds.length === 0) {
          return { id: 'FORBIDDEN_NO_DEPARTMENTS' };
        }
        employeeScopeFilter = {
          departmentId: { in: actor.departmentIds },
        };
        break;

      case DataScope.ALL:
        employeeScopeFilter = {};
        break;

      default:
        return { id: 'FORBIDDEN_UNSUPPORTED_SCOPE' };
    }

    return {
      AND: [
        { deletedAt: null },
        employeeCeiling,
        employeeScopeFilter,
      ],
    };
  }

  return { id: 'FORBIDDEN_UNKNOWN_USER_TYPE' };
}

/**
 * Helper to build the complete TaskActorContext for a user using UsersService and Prisma.
 */
export async function resolveActorTaskContext(
  prisma: any,
  usersService: any,
  actorUserId: string,
  actorUserType: string,
  permissionCode: string,
): Promise<TaskActorContext> {
  const effectiveDataScope = await usersService.resolveActorDataScope(
    actorUserId,
    actorUserType,
    permissionCode,
  );

  const userDepts =
    (await prisma.userDepartment.findMany({
      where: { userId: actorUserId },
      select: { departmentId: true },
    })) || [];
  const departmentIds = userDepts.map((d: any) => d.departmentId);

  const subordinates =
    (await prisma.user.findMany({
      where: {
        deletedAt: null,
        employeeProfile: {
          reportingToId: actorUserId,
        },
      },
      select: { id: true },
    })) || [];
  const subordinateUserIds = subordinates.map((s: any) => s.id);

  return {
    userId: actorUserId,
    userType: actorUserType,
    departmentIds,
    subordinateUserIds,
    effectiveDataScope,
  };
}


