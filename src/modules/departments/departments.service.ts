import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { QueryDepartmentsDto } from './dto/query-departments.dto';
import { Prisma, RecordStatus, AuditAction } from '../../generated/prisma/client';

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Retrieves active departments with search, hierarchy, user count, and optional pagination.
   */
  async getDepartments(query: QueryDepartmentsDto) {
    const where: Prisma.DepartmentWhereInput = {
      deletedAt: null,
    };

    if (query.status) {
      where.status = query.status;
    } else {
      where.status = RecordStatus.ACTIVE;
    }

    if (query.search && query.search.trim().length > 0) {
      const keyword = query.search.trim();
      where.OR = [
        { name: { contains: keyword } },
        { code: { contains: keyword } },
        { description: { contains: keyword } },
      ];
    }

    const includeChildren = query.includeChildren ?? true;
    const includeConfig = {
      parent: {
        select: { id: true, code: true, name: true },
      },
      children: includeChildren
        ? {
            where: { deletedAt: null, status: RecordStatus.ACTIVE },
            select: { id: true, code: true, name: true, status: true },
          }
        : false,
      _count: {
        select: {
          users: true,
          children: true,
        },
      },
    };

    // If 'all' is requested or pagination is not specified, return full active list for frontend dropdowns
    const isAll = query.all === true || (query.page === undefined && query.limit === undefined);

    if (isAll) {
      const departments = await this.prisma.department.findMany({
        where,
        orderBy: [{ name: 'asc' }],
        include: includeConfig,
      });

      const formatted = departments.map((d) => this.formatDepartmentItem(d));
      return {
        items: formatted,
        total: formatted.length,
      };
    }

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
    const skip = (page - 1) * limit;

    const [total, departments] = await Promise.all([
      this.prisma.department.count({ where }),
      this.prisma.department.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ name: 'asc' }],
        include: includeConfig,
      }),
    ]);

    const formatted = departments.map((d) => this.formatDepartmentItem(d));

    return {
      items: formatted,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Retrieves single department details by ID.
   */
  async getDepartmentById(id: string) {
    const department = await this.prisma.department.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      include: {
        parent: {
          select: { id: true, code: true, name: true },
        },
        children: {
          where: { deletedAt: null },
          select: { id: true, code: true, name: true, status: true },
        },
        users: {
          select: {
            isPrimary: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                userCode: true,
                status: true,
                employeeProfile: {
                  select: { designation: true },
                },
              },
            },
          },
        },
        _count: {
          select: {
            users: true,
            children: true,
            tasks: true,
            leads: true,
          },
        },
      },
    });

    if (!department) {
      throw new NotFoundException(
        'The requested department could not be found or has been deactivated.',
      );
    }

    return this.formatDepartmentDetail(department);
  }

  /**
   * Creates a new department dynamically.
   */
  async createDepartment(dto: CreateDepartmentDto, actorUserId: string) {
    const normalizedCode = dto.code.trim().toUpperCase();

    // Check uniqueness of code
    const existing = await this.prisma.department.findUnique({
      where: { code: normalizedCode },
    });

    if (existing) {
      if (existing.deletedAt) {
        // If it was soft-deleted, reactivate and update it
        const reactivated = await this.prisma.department.update({
          where: { id: existing.id },
          data: {
            name: dto.name.trim(),
            description: dto.description?.trim() || null,
            parentId: dto.parentId || null,
            status: dto.status ?? RecordStatus.ACTIVE,
            deletedAt: null,
          },
        });

        await this.auditService.logAudit({
          actorUserId,
          action: AuditAction.UPDATE,
          module: 'departments',
          entityType: 'Department',
          entityId: reactivated.id,
          newValues: reactivated,
        });

        return this.formatDepartmentItem(reactivated);
      }

      throw new ConflictException(
        `A department with the code "${normalizedCode}" already exists. Please choose a different code.`,
      );
    }

    // If parentId provided, verify parent exists and is not deleted
    if (dto.parentId) {
      const parent = await this.prisma.department.findFirst({
        where: { id: dto.parentId, deletedAt: null },
      });
      if (!parent) {
        throw new BadRequestException(
          'The specified parent department could not be found.',
        );
      }
    }

    const created = await this.prisma.department.create({
      data: {
        code: normalizedCode,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        parentId: dto.parentId || null,
        status: dto.status ?? RecordStatus.ACTIVE,
      },
      include: {
        parent: {
          select: { id: true, code: true, name: true },
        },
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'departments',
      entityType: 'Department',
      entityId: created.id,
      newValues: created,
    });

    return this.formatDepartmentItem(created);
  }

  /**
   * Updates an existing department.
   */
  async updateDepartment(
    id: string,
    dto: UpdateDepartmentDto,
    actorUserId: string,
  ) {
    const existing = await this.prisma.department.findFirst({
      where: { id, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(
        'The requested department could not be found or has been deactivated.',
      );
    }

    const updateData: Prisma.DepartmentUpdateInput = {};

    if (dto.name !== undefined) {
      updateData.name = dto.name.trim();
    }
    if (dto.description !== undefined) {
      updateData.description = dto.description?.trim() || null;
    }
    if (dto.status !== undefined) {
      updateData.status = dto.status;
    }

    if (dto.parentId !== undefined) {
      if (dto.parentId === id) {
        throw new BadRequestException(
          'A department cannot be configured as its own parent.',
        );
      }

      if (dto.parentId !== null) {
        const parent = await this.prisma.department.findFirst({
          where: { id: dto.parentId, deletedAt: null },
        });
        if (!parent) {
          throw new BadRequestException(
            'The selected parent department could not be found.',
          );
        }

        // Circular hierarchy guard
        const isDescendant = await this.checkIsDescendant(id, dto.parentId);
        if (isDescendant) {
          throw new BadRequestException(
            'Cannot set parent: this would create a circular department loop.',
          );
        }

        updateData.parent = { connect: { id: dto.parentId } };
      } else {
        updateData.parent = { disconnect: true };
      }
    }

    const updated = await this.prisma.department.update({
      where: { id },
      data: updateData,
      include: {
        parent: { select: { id: true, code: true, name: true } },
        _count: { select: { users: true, children: true } },
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'departments',
      entityType: 'Department',
      entityId: id,
      oldValues: existing,
      newValues: updated,
    });

    return this.formatDepartmentItem(updated);
  }

  /**
   * Safely deletes or deactivates a department.
   */
  async deleteDepartment(id: string, actorUserId: string) {
    const existing = await this.prisma.department.findFirst({
      where: { id, deletedAt: null },
      include: {
        _count: {
          select: {
            users: true,
            children: { where: { deletedAt: null } },
            tasks: true,
            leads: true,
          },
        },
      },
    });

    if (!existing) {
      throw new NotFoundException(
        'The requested department could not be found or has already been removed.',
      );
    }

    // Business check 1: Active assigned employees
    if (existing._count.users > 0) {
      throw new BadRequestException(
        `Cannot remove department "${existing.name}" because it currently has ${existing._count.users} active employee(s) assigned. Please reassign the employees before deleting this department.`,
      );
    }

    // Business check 2: Sub-departments
    if (existing._count.children > 0) {
      throw new BadRequestException(
        `Cannot remove department "${existing.name}" because it contains ${existing._count.children} sub-department(s). Please reassign or delete the sub-departments first.`,
      );
    }

    // Safe soft delete
    const deleted = await this.prisma.department.update({
      where: { id },
      data: {
        status: RecordStatus.INACTIVE,
        deletedAt: new Date(),
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.DELETE,
      module: 'departments',
      entityType: 'Department',
      entityId: id,
      oldValues: existing,
    });

    return {
      message: `Department "${existing.name}" has been successfully removed.`,
    };
  }

  // ===========================================================================
  // PRIVATE HELPER METHODS
  // ===========================================================================

  private formatDepartmentItem(d: any) {
    return {
      id: d.id,
      code: d.code,
      name: d.name,
      description: d.description || null,
      status: d.status,
      parentId: d.parentId || null,
      parent: d.parent ? { id: d.parent.id, code: d.parent.code, name: d.parent.name } : null,
      children: Array.isArray(d.children) ? d.children : [],
      userCount: d._count?.users ?? 0,
      subDepartmentCount: d._count?.children ?? 0,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  }

  private formatDepartmentDetail(d: any) {
    const formatted = this.formatDepartmentItem(d);
    return {
      ...formatted,
      activeEmployees: (d.users || []).map((u: any) => ({
        id: u.user.id,
        name: u.user.name,
        email: u.user.email,
        userCode: u.user.userCode,
        designation: u.user.employeeProfile?.designation || null,
        isPrimary: u.isPrimary,
        status: u.user.status,
      })),
      statistics: {
        totalEmployees: d._count?.users ?? 0,
        subDepartments: d._count?.children ?? 0,
        activeTasks: d._count?.tasks ?? 0,
        activeLeads: d._count?.leads ?? 0,
      },
    };
  }

  private async checkIsDescendant(ancestorId: string, candidateChildId: string): Promise<boolean> {
    let curr: string | null = candidateChildId;
    let depth = 0;
    while (curr && depth < 20) {
      if (curr === ancestorId) return true;
      const found: { parentId: string | null } | null = await this.prisma.department.findUnique({
        where: { id: curr },
        select: { parentId: true },
      });
      curr = found?.parentId || null;
      depth++;
    }
    return false;
  }
}
