import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';
import { PermissionQueryDto } from './dto/permission-query.dto';
import { AuditAction, RecordStatus } from '../../generated/prisma/enums';

@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Creates a new system permission.
   */
  async create(dto: CreatePermissionDto, actorUserId?: string) {
    const existing = await this.prisma.permission.findUnique({
      where: { code: dto.code },
    });

    if (existing) {
      throw new ConflictException(
        `Permission with code '${dto.code}' already exists.`,
      );
    }

    const permission = await this.prisma.permission.create({
      data: {
        code: dto.code,
        name: dto.name,
        module: dto.module,
        action: dto.action,
        description: dto.description || null,
        status: RecordStatus.ACTIVE,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'permissions',
      entityType: 'Permission',
      entityId: permission.id,
      newValues: permission,
    });

    return permission;
  }

  /**
   * Retrieves permissions with pagination, search, and filtering.
   */
  async findAll(query: PermissionQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.module) {
      where.module = query.module;
    }

    if (query.search) {
      where.OR = [
        { code: { contains: query.search } },
        { name: { contains: query.search } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.permission.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ module: 'asc' }, { code: 'asc' }],
      }),
      this.prisma.permission.count({ where }),
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
   * Retrieves all permissions grouped by their module.
   */
  async findGroupedByModule() {
    const permissions = await this.prisma.permission.findMany({
      where: { status: RecordStatus.ACTIVE },
      orderBy: [{ module: 'asc' }, { code: 'asc' }],
    });

    const grouped: Record<
      string,
      Array<{ id: string; code: string; name: string; action: string }>
    > = {};

    for (const p of permissions) {
      if (!grouped[p.module]) {
        grouped[p.module] = [];
      }
      grouped[p.module].push({
        id: p.id,
        code: p.code,
        name: p.name,
        action: p.action,
      });
    }

    return grouped;
  }

  /**
   * Retrieves a single permission by ID.
   */
  async findOne(id: string) {
    const permission = await this.prisma.permission.findUnique({
      where: { id },
      include: {
        roles: {
          include: {
            role: {
              select: { id: true, code: true, name: true, isSystem: true },
            },
          },
        },
      },
    });

    if (!permission) {
      throw new NotFoundException(`Permission with ID '${id}' not found.`);
    }

    return permission;
  }

  /**
   * Updates permission metadata and status.
   */
  async update(id: string, dto: UpdatePermissionDto, actorUserId?: string) {
    const existing = await this.findOne(id);

    const updated = await this.prisma.permission.update({
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
      module: 'permissions',
      entityType: 'Permission',
      entityId: id,
      oldValues: existing,
      newValues: updated,
    });

    return updated;
  }

  /**
   * Deletes a permission, ensuring it is not attached to protected system roles.
   */
  async remove(id: string, actorUserId?: string) {
    const existing = await this.findOne(id);

    // Check if permission is assigned to any system role
    const assignedSystemRoles = existing.roles.filter(
      (rp) => rp.role.isSystem,
    );

    if (assignedSystemRoles.length > 0) {
      const roleNames = assignedSystemRoles.map((r) => r.role.name).join(', ');
      throw new BadRequestException(
        `Cannot delete permission '${existing.code}' because it is assigned to protected system role(s): ${roleNames}.`,
      );
    }

    await this.prisma.permission.delete({
      where: { id },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.DELETE,
      module: 'permissions',
      entityType: 'Permission',
      entityId: id,
      oldValues: existing,
    });

    return { message: `Permission '${existing.code}' deleted successfully.` };
  }
}

