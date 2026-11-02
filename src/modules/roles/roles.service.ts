import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AssignPermissionsDto } from './dto/assign-permissions.dto';
import { PermissionAssignmentItemDto } from './dto/permission-assignment-item.dto';
import { RoleQueryDto } from './dto/role-query.dto';
import {
  AuditAction,
  DataScope,
  PermissionEffect,
  RecordStatus,
} from '../../generated/prisma/enums';

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Helper to resolve effective permissions for a user (roles + direct overrides).
   */
  async getActorEffectivePermissions(actorUserId: string): Promise<Set<string>> {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId: actorUserId },
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

    const directPermissions = await this.prisma.userPermission.findMany({
      where: { userId: actorUserId },
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

  /**
   * Enforces permission delegation authority: Non-Super Admin users can only
   * assign permissions they themselves possess.
   */
  private async validateDelegationAuthority(
    permissionIds: string[],
    actorUserId?: string,
    actorUserType?: string,
  ): Promise<void> {
    if (actorUserType === 'SUPER_ADMIN' || !actorUserId) {
      return;
    }

    const actorPermissions = await this.getActorEffectivePermissions(actorUserId);

    const permissionsToAssign = await this.prisma.permission.findMany({
      where: { id: { in: permissionIds } },
      select: { id: true, code: true },
    });

    const unauthorizedCodes: string[] = [];
    for (const p of permissionsToAssign) {
      if (!actorPermissions.has(p.code)) {
        unauthorizedCodes.push(p.code);
      }
    }

    if (unauthorizedCodes.length > 0) {
      throw new ForbiddenException(
        `Cannot delegate permissions you do not possess: [${unauthorizedCodes.join(', ')}]`,
      );
    }
  }

  /**
   * Creates a new custom role with optional initial permissions.
   */
  async create(
    dto: CreateRoleDto,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const existing = await this.prisma.role.findUnique({
      where: { code: dto.code },
    });

    if (existing) {
      throw new ConflictException(
        `Role with code '${dto.code}' already exists.`,
      );
    }

    // Validate permission IDs if provided
    if (dto.permissions && dto.permissions.length > 0) {
      const permIds = dto.permissions.map((p) => p.permissionId);
      const activeCount = await this.prisma.permission.count({
        where: { id: { in: permIds }, status: RecordStatus.ACTIVE },
      });

      if (activeCount !== permIds.length) {
        throw new BadRequestException(
          'One or more specified permission IDs are invalid or inactive.',
        );
      }

      // Enforce delegation authority
      await this.validateDelegationAuthority(permIds, actorUserId, actorUserType);
    }

    const role = await this.prisma.$transaction(async (tx) => {
      const createdRole = await tx.role.create({
        data: {
          code: dto.code,
          name: dto.name,
          description: dto.description || null,
          isSystem: false,
          status: RecordStatus.ACTIVE,
        },
      });

      if (dto.permissions && dto.permissions.length > 0) {
        for (const p of dto.permissions) {
          await tx.rolePermission.create({
            data: {
              roleId: createdRole.id,
              permissionId: p.permissionId,
              dataScope: p.dataScope || DataScope.ALL,
            },
          });
        }
      }

      return createdRole;
    });

    const fullRole = await this.findOne(role.id);

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'roles',
      entityType: 'Role',
      entityId: role.id,
      newValues: fullRole,
    });

    return fullRole;
  }

  /**
   * Retrieves roles with pagination, search, and status filters.
   */
  async findAll(query: RoleQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (!query.includeDeleted) {
      where.deletedAt = null;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.search && query.search.trim().length > 0) {
      const term = query.search.trim();
      where.OR = [
        { code: { contains: term } },
        { name: { contains: term } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.role.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
        include: {
          _count: {
            select: { users: true, permissions: true },
          },
        },
      }),
      this.prisma.role.count({ where }),
    ]);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Retrieves single role details including permissions and assigned user count.
   * Rejects soft-deleted roles with 404 unless includeDeleted is explicitly true.
   */
  async findOne(id: string, includeDeleted = false) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
        _count: {
          select: { users: true },
        },
      },
    });

    if (!role || (role.deletedAt && !includeDeleted)) {
      throw new NotFoundException(`Role with ID '${id}' not found.`);
    }

    return role;
  }

  /**
   * Updates role name, description, or status.
   * Protects system roles: only Super Admin can modify system roles.
   */
  async update(
    id: string,
    dto: UpdateRoleDto,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const existing = await this.findOne(id);

    // System role protection
    if (existing.isSystem && actorUserType !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Only Super Admin can modify protected system roles.',
      );
    }

    // Super Admin deactivation protection
    if (existing.code === 'SUPER_ADMIN' && dto.status === RecordStatus.INACTIVE) {
      throw new ForbiddenException(
        'The protected Super Admin role cannot be deactivated.',
      );
    }

    const updated = await this.prisma.role.update({
      where: { id },
      data: {
        name: dto.name !== undefined ? dto.name : existing.name,
        description:
          dto.description !== undefined ? dto.description : existing.description,
        status: dto.status !== undefined ? dto.status : existing.status,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'roles',
      entityType: 'Role',
      entityId: id,
      oldValues: existing,
      newValues: updated,
    });

    return updated;
  }

  /**
   * Soft deletes a role after safety checks.
   */
  async remove(
    id: string,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const existing = await this.findOne(id);

    if (existing.isSystem) {
      throw new BadRequestException(
        `Cannot delete role '${existing.name}' because it is a protected system role.`,
      );
    }

    // Check if any active user is assigned to this role
    const activeUsersCount = await this.prisma.userRole.count({
      where: {
        roleId: id,
        user: {
          status: RecordStatus.ACTIVE,
          deletedAt: null,
        },
      },
    });

    if (activeUsersCount > 0) {
      throw new BadRequestException(
        `Cannot delete role '${existing.name}' because it is currently assigned to ${activeUsersCount} active user(s). Please reassign them first.`,
      );
    }

    const now = new Date();
    await this.prisma.role.update({
      where: { id },
      data: {
        deletedAt: now,
        status: RecordStatus.INACTIVE,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.DELETE,
      module: 'roles',
      entityType: 'Role',
      entityId: id,
      oldValues: existing,
    });

    return { message: `Role '${existing.name}' soft deleted successfully.` };
  }

  /**
   * Restores a soft-deleted custom role.
   * Restricted to Super Admin.
   */
  async restore(
    id: string,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    if (actorUserType !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only Super Admin can restore roles.');
    }

    const role = await this.findOne(id, true);

    if (!role.deletedAt) {
      throw new BadRequestException(`Role '${role.name}' is not deleted.`);
    }

    if (role.isSystem) {
      throw new BadRequestException(
        'Protected system roles cannot be restored through this endpoint.',
      );
    }

    const restored = await this.prisma.role.update({
      where: { id },
      data: {
        deletedAt: null,
        status: RecordStatus.ACTIVE,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.RESTORE,
      module: 'roles',
      entityType: 'Role',
      entityId: id,
      newValues: restored,
    });

    return restored;
  }

  /**
   * Replaces all permissions for a role in an atomic transaction.
   * Enforces delegation authority: non-Super Admin callers can only assign
   * permissions they themselves possess.
   */
  async replacePermissions(
    id: string,
    dto: AssignPermissionsDto,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const role = await this.findOne(id);

    if (role.code === 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Super Admin role permissions are system-defined and cannot be manually replaced.',
      );
    }

    // Validate permission IDs
    const permIds = dto.permissions.map((p) => p.permissionId);
    const activeCount = await this.prisma.permission.count({
      where: { id: { in: permIds }, status: RecordStatus.ACTIVE },
    });

    if (activeCount !== permIds.length) {
      throw new BadRequestException(
        'One or more specified permission IDs are invalid or inactive.',
      );
    }

    // Enforce delegation authority
    await this.validateDelegationAuthority(permIds, actorUserId, actorUserType);

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({
        where: { roleId: id },
      });

      for (const p of dto.permissions) {
        await tx.rolePermission.create({
          data: {
            roleId: id,
            permissionId: p.permissionId,
            dataScope: p.dataScope || DataScope.ALL,
          },
        });
      }
    });

    const updatedRole = await this.findOne(id);

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.PERMISSION_CHANGE,
      module: 'roles',
      entityType: 'Role',
      entityId: id,
      newValues: { assignedPermissionsCount: dto.permissions.length },
    });

    return updatedRole;
  }

  /**
   * Adds or updates a single permission on a role.
   * Enforces delegation authority for non-Super Admin callers.
   */
  async addPermission(
    id: string,
    dto: PermissionAssignmentItemDto,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const role = await this.findOne(id);

    const permission = await this.prisma.permission.findUnique({
      where: { id: dto.permissionId },
    });

    if (!permission || permission.status !== RecordStatus.ACTIVE) {
      throw new BadRequestException('Invalid or inactive permission ID.');
    }

    // Enforce delegation authority
    await this.validateDelegationAuthority(
      [dto.permissionId],
      actorUserId,
      actorUserType,
    );

    await this.prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: id,
          permissionId: dto.permissionId,
        },
      },
      update: {
        dataScope: dto.dataScope || DataScope.ALL,
      },
      create: {
        roleId: id,
        permissionId: dto.permissionId,
        dataScope: dto.dataScope || DataScope.ALL,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.PERMISSION_CHANGE,
      module: 'roles',
      entityType: 'RolePermission',
      entityId: `${id}_${dto.permissionId}`,
      newValues: {
        roleCode: role.code,
        permissionCode: permission.code,
        dataScope: dto.dataScope,
      },
    });

    return this.getRolePermissions(id);
  }

  /**
   * Removes a single permission from a role.
   */
  async removePermission(
    id: string,
    permissionId: string,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const role = await this.findOne(id);

    if (role.code === 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Permissions cannot be removed from the Super Admin role.',
      );
    }

    const existing = await this.prisma.rolePermission.findUnique({
      where: {
        roleId_permissionId: {
          roleId: id,
          permissionId,
        },
      },
    });

    if (!existing) {
      throw new NotFoundException('Permission is not assigned to this role.');
    }

    await this.prisma.rolePermission.delete({
      where: {
        roleId_permissionId: {
          roleId: id,
          permissionId,
        },
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.PERMISSION_CHANGE,
      module: 'roles',
      entityType: 'RolePermission',
      entityId: `${id}_${permissionId}`,
      oldValues: existing,
    });

    return { message: 'Permission removed from role successfully.' };
  }

  /**
   * Gets all permissions assigned to a role.
   */
  async getRolePermissions(id: string) {
    await this.findOne(id);

    const assignments = await this.prisma.rolePermission.findMany({
      where: { roleId: id },
      include: {
        permission: true,
      },
      orderBy: { permission: { module: 'asc' } },
    });

    return assignments.map((rp) => ({
      permissionId: rp.permissionId,
      code: rp.permission.code,
      name: rp.permission.name,
      module: rp.permission.module,
      action: rp.permission.action,
      dataScope: rp.dataScope,
      assignedAt: rp.assignedAt,
    }));
  }
}
