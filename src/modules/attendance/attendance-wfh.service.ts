import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { UsersService } from '../users/users.service';
import { AttendanceAccessService } from './attendance-access.service';
import {
  AuditAction,
  WfhStatus,
} from '../../generated/prisma/enums';
import { CreateWfhRequestDto } from './dto/create-wfh-request.dto';
import { RejectWfhRequestDto } from './dto/reject-wfh-request.dto';
import { QueryWfhRequestsDto } from './dto/query-wfh-requests.dto';
import { intervalsOverlap, parseDateOnly } from './attendance.utils';

@Injectable()
export class AttendanceWfhService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly usersService: UsersService,
    private readonly accessService: AttendanceAccessService,
  ) {}

  /**
   * Submits a new WFH request with date-range validation and conflict prevention.
   */
  async createRequest(
    userId: string,
    dto: CreateWfhRequestDto,
    actorUserId: string,
  ) {
    const startDate = parseDateOnly(dto.startDate);
    const endDate = parseDateOnly(dto.endDate);

    if (startDate.getTime() > endDate.getTime()) {
      throw new BadRequestException('WFH startDate must be on or before endDate.');
    }

    // Prevent overlapping pending or approved WFH requests for this employee
    const existingRequests = await this.prisma.attendanceWfhRequest.findMany({
      where: {
        userId,
        status: {
          in: [WfhStatus.PENDING, WfhStatus.APPROVED],
        },
      },
    });

    for (const ex of existingRequests) {
      if (intervalsOverlap(startDate, endDate, ex.startDate, ex.endDate)) {
        throw new ConflictException(
          `An overlapping ${ex.status.toLowerCase()} WFH request (${ex.id}) already exists for the requested date range.`,
        );
      }
    }

    const created = await this.prisma.attendanceWfhRequest.create({
      data: {
        userId,
        startDate,
        endDate,
        reason: dto.reason.trim(),
        status: WfhStatus.PENDING,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'ATTENDANCE',
      entityType: 'AttendanceWfhRequest',
      entityId: created.id,
      newValues: {
        userId,
        startDate: dto.startDate,
        endDate: dto.endDate,
        reason: dto.reason,
        status: WfhStatus.PENDING,
      },
    });

    return created;
  }

  /**
   * Retrieves an employee's own WFH requests.
   */
  async getMyRequests(userId: string, query: QueryWfhRequestsDto) {
    const { status, startDate, endDate, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: any = { userId };
    if (status) where.status = status;
    if (startDate) where.endDate = { gte: parseDateOnly(startDate) };
    if (endDate) where.startDate = { lte: parseDateOnly(endDate) };

    const [items, total] = await Promise.all([
      this.prisma.attendanceWfhRequest.findMany({
        where,
        orderBy: { startDate: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.attendanceWfhRequest.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Retrieves paginated WFH requests scoped by the manager's effective data scope.
   */
  async getScopedRequests(
    actorUserId: string,
    actorUserType: string,
    query: QueryWfhRequestsDto,
  ) {
    const { userId, status, startDate, endDate, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    if (userId) {
      await this.accessService.assertSupervisorAccess(
        userId,
        actorUserId,
        actorUserType,
        'attendance.view_wfh',
      );
    }

    const userScopeWhere = await this.usersService.buildDataScopeWhere(
      actorUserId,
      actorUserType,
      'attendance.view_wfh',
    );

    const where: any = {
      user: userScopeWhere,
    };
    if (userId) where.userId = userId;
    if (status) where.status = status;
    if (startDate) where.endDate = { gte: parseDateOnly(startDate) };
    if (endDate) where.startDate = { lte: parseDateOnly(endDate) };

    const [items, total] = await Promise.all([
      this.prisma.attendanceWfhRequest.findMany({
        where,
        include: {
          user: {
            select: { id: true, name: true, email: true, userCode: true },
          },
          reviewer: {
            select: { id: true, name: true, email: true, userCode: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.attendanceWfhRequest.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Approves a pending WFH request under Level 6 lock.
   * Note: WFH approval authorizes remote work; it does NOT automatically create
   * attendance sessions or mark an employee present.
   */
  async approveRequest(
    requestId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    const request = await this.prisma.attendanceWfhRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException(`WFH request with ID "${requestId}" not found.`);
    }

    // 1. Prevent self-approval
    if (request.userId === actorUserId) {
      throw new ForbiddenException(
        'Self-approval of WFH requests is strictly prohibited.',
      );
    }

    // 2. Enforce supervisor data scope
    await this.accessService.assertSupervisorAccess(
      request.userId,
      actorUserId,
      actorUserType,
      'attendance.approve_wfh',
    );

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // Level 6 Lock: AttendanceWfhRequest
      await tx.$queryRaw`
        SELECT id FROM attendance_wfh_requests WHERE id = ${requestId} FOR UPDATE
      `;

      const current = await tx.attendanceWfhRequest.findUniqueOrThrow({
        where: { id: requestId },
      });

      if (current.status !== WfhStatus.PENDING) {
        throw new BadRequestException(
          `WFH request is no longer pending (current status: ${current.status}).`,
        );
      }

      return tx.attendanceWfhRequest.update({
        where: { id: requestId },
        data: {
          status: WfhStatus.APPROVED,
          reviewedByUserId: actorUserId,
          reviewedAt: now,
        },
      });
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'ATTENDANCE',
      entityType: 'AttendanceWfhRequest',
      entityId: updated.id,
      newValues: {
        status: WfhStatus.APPROVED,
        reviewedByUserId: actorUserId,
        reviewedAt: now.toISOString(),
      },
    });

    return updated;
  }

  /**
   * Rejects a pending WFH request under Level 6 lock.
   */
  async rejectRequest(
    requestId: string,
    actorUserId: string,
    actorUserType: string,
    dto: RejectWfhRequestDto = {},
  ) {
    const request = await this.prisma.attendanceWfhRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException(`WFH request with ID "${requestId}" not found.`);
    }

    // 1. Prevent self-review
    if (request.userId === actorUserId) {
      throw new ForbiddenException(
        'Self-approval or self-review of WFH requests is strictly prohibited.',
      );
    }

    // 2. Enforce supervisor data scope
    await this.accessService.assertSupervisorAccess(
      request.userId,
      actorUserId,
      actorUserType,
      'attendance.approve_wfh',
    );

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // Level 6 Lock: AttendanceWfhRequest
      await tx.$queryRaw`
        SELECT id FROM attendance_wfh_requests WHERE id = ${requestId} FOR UPDATE
      `;

      const current = await tx.attendanceWfhRequest.findUniqueOrThrow({
        where: { id: requestId },
      });

      if (current.status !== WfhStatus.PENDING) {
        throw new BadRequestException(
          `WFH request is no longer pending (current status: ${current.status}).`,
        );
      }

      return tx.attendanceWfhRequest.update({
        where: { id: requestId },
        data: {
          status: WfhStatus.REJECTED,
          reviewedByUserId: actorUserId,
          reviewedAt: now,
        },
      });
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'ATTENDANCE',
      entityType: 'AttendanceWfhRequest',
      entityId: updated.id,
      newValues: {
        status: WfhStatus.REJECTED,
        managerNotes: dto.managerNotes,
        reviewedByUserId: actorUserId,
        reviewedAt: now.toISOString(),
      },
    });

    return updated;
  }

  /**
   * Cancels an employee's own pending WFH request under Level 6 lock.
   */
  async cancelRequest(requestId: string, userId: string) {
    const request = await this.prisma.attendanceWfhRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException(`WFH request with ID "${requestId}" not found.`);
    }

    if (request.userId !== userId) {
      throw new ForbiddenException(
        'You can only cancel your own WFH requests.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Level 6 Lock: AttendanceWfhRequest
      await tx.$queryRaw`
        SELECT id FROM attendance_wfh_requests WHERE id = ${requestId} FOR UPDATE
      `;

      const current = await tx.attendanceWfhRequest.findUniqueOrThrow({
        where: { id: requestId },
      });

      if (current.status !== WfhStatus.PENDING) {
        throw new BadRequestException(
          'Only pending WFH requests can be cancelled.',
        );
      }

      return tx.attendanceWfhRequest.update({
        where: { id: requestId },
        data: {
          status: WfhStatus.CANCELLED,
        },
      });
    });

    await this.auditService.logAudit({
      actorUserId: userId,
      action: AuditAction.UPDATE,
      module: 'ATTENDANCE',
      entityType: 'AttendanceWfhRequest',
      entityId: updated.id,
      newValues: {
        status: WfhStatus.CANCELLED,
      },
    });

    return updated;
  }
}

