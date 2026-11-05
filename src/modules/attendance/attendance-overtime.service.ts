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
import { AttendanceCalculationService } from './attendance-calculation.service';
import {
  AuditAction,
  OvertimeApprovalStatus,
  RecordStatus,
} from '../../generated/prisma/enums';
import { CreateOvertimeRequestDto } from './dto/create-overtime-request.dto';
import { ApproveOvertimeRequestDto } from './dto/approve-overtime-request.dto';
import { RejectOvertimeRequestDto } from './dto/reject-overtime-request.dto';
import { QueryOvertimeRequestsDto } from './dto/query-overtime-requests.dto';
import { parseDateOnly } from './attendance.utils';

@Injectable()
export class AttendanceOvertimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly usersService: UsersService,
    private readonly accessService: AttendanceAccessService,
    private readonly calculationService: AttendanceCalculationService,
  ) {}

  /**
   * Helper to check whether an actor explicitly possesses the attendance.override_overtime_limit permission.
   * Does NOT grant automatically based on userType (ADMIN, SUPER_ADMIN, HR).
   */
  private async hasOverridePermission(actorUserId: string): Promise<boolean> {
    const roleHasPerm = await this.prisma.userRole.findFirst({
      where: {
        userId: actorUserId,
        role: {
          permissions: {
            some: {
              permission: {
                code: 'attendance.override_overtime_limit',
                status: RecordStatus.ACTIVE,
              },
            },
          },
        },
      },
    });
    if (roleHasPerm) return true;

    const directPerm = await this.prisma.userPermission.findFirst({
      where: {
        userId: actorUserId,
        permission: {
          code: 'attendance.override_overtime_limit',
          status: RecordStatus.ACTIVE,
        },
        effect: 'ALLOW',
      },
    });
    return Boolean(directPerm);
  }

  /**
   * Submits a new employee overtime request with interval validation, limit checks, and overlap prevention.
   */
  async createRequest(
    userId: string,
    dto: CreateOvertimeRequestDto,
    actorUserId: string,
    actorUserType: string,
  ) {
    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);

    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      throw new BadRequestException('Invalid start or end timestamp format.');
    }

    if (startTime.getTime() >= endTime.getTime()) {
      throw new BadRequestException(
        'Overtime startTime must be strictly before endTime.',
      );
    }

    const durationMinutes = Math.floor(
      (endTime.getTime() - startTime.getTime()) / 60000,
    );
    if (durationMinutes <= 0) {
      throw new BadRequestException('Requested overtime duration must be at least 1 minute.');
    }

    const attendanceDate = parseDateOnly(dto.attendanceDate);

    // Pessimistic transaction with Level 1 lock on EmployeeProfile to serialize request creation
    // and strictly prevent simultaneous requests exceeding the daily overtime ceiling.
    const created = await this.prisma.$transaction(async (tx) => {
      // Level 1 Lock: EmployeeProfile
      await tx.employeeProfile.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
      await tx.$queryRaw`
        SELECT id FROM employee_profiles WHERE user_id = ${userId} FOR UPDATE
      `;

      // Level 5 Lock: AttendanceOvertimeRequest
      // In MySQL InnoDB REPEATABLE READ, a locking read (FOR UPDATE) is a "current read"
      // that bypasses MVCC snapshot and guarantees visibility of rows committed by concurrent transactions.
      const lockedExisting = await tx.$queryRaw<
        Array<{
          id: string;
          approved_duration_minutes: number | null;
          start_time: Date;
          end_time: Date;
          status: string;
        }>
      >`
        SELECT id, approved_duration_minutes, start_time, end_time, status
        FROM attendance_overtime_requests
        WHERE user_id = ${userId} AND attendance_date = ${attendanceDate}
          AND status IN ('PENDING', 'APPROVED')
        ORDER BY id ASC
        FOR UPDATE
      `;

      // 1. Enforce configured overtime limits considering existing pending + approved requests
      const existingMinutes = lockedExisting.reduce((sum, r) => {
        const reqMinutes = Math.floor(
          (new Date(r.end_time).getTime() - new Date(r.start_time).getTime()) /
            60000,
        );
        return sum + (r.approved_duration_minutes ?? reqMinutes);
      }, 0);

      const MAX_DAILY_OVERTIME_MINUTES = 240;
      if (existingMinutes + durationMinutes > MAX_DAILY_OVERTIME_MINUTES) {
        const canOverride = await this.hasOverridePermission(actorUserId);
        if (!canOverride) {
          throw new BadRequestException(
            `Requested overtime duration of ${durationMinutes} minutes combined with existing pending/approved overtime (${existingMinutes}m) exceeds the daily limit of ${MAX_DAILY_OVERTIME_MINUTES} minutes. Explicit attendance.override_overtime_limit permission is required to override.`,
          );
        }
      }

      // 2. Prevent overlapping / duplicate pending or approved requests for this user on this date
      for (const existing of lockedExisting) {
        const exStart = new Date(existing.start_time).getTime();
        const exEnd = new Date(existing.end_time).getTime();
        const reqStart = startTime.getTime();
        const reqEnd = endTime.getTime();

        // Strict interval overlap condition: max(reqStart, exStart) < min(reqEnd, exEnd)
        if (Math.max(reqStart, exStart) < Math.min(reqEnd, exEnd)) {
          throw new ConflictException(
            `An overlapping ${existing.status.toLowerCase()} overtime request (${existing.id}) already exists for this date and time window.`,
          );
        }
      }

      return tx.attendanceOvertimeRequest.create({
        data: {
          userId,
          attendanceDate,
          startTime,
          endTime,
          approvedDurationMinutes: durationMinutes,
          reason: dto.reason.trim(),
          status: OvertimeApprovalStatus.PENDING,
        },
      });
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'ATTENDANCE',
      entityType: 'AttendanceOvertimeRequest',
      entityId: created.id,
      newValues: {
        userId,
        attendanceDate: dto.attendanceDate,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        durationMinutes,
        status: OvertimeApprovalStatus.PENDING,
      },
    });

    return created;
  }

  /**
   * Retrieves an employee's own overtime request history.
   */
  async getMyRequests(userId: string, query: QueryOvertimeRequestsDto) {
    const { status, startDate, endDate, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: any = { userId };
    if (status) where.status = status;
    if (startDate || endDate) {
      where.attendanceDate = {};
      if (startDate) where.attendanceDate.gte = parseDateOnly(startDate);
      if (endDate) where.attendanceDate.lte = parseDateOnly(endDate);
    }

    const [items, total] = await Promise.all([
      this.prisma.attendanceOvertimeRequest.findMany({
        where,
        orderBy: { attendanceDate: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.attendanceOvertimeRequest.count({ where }),
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
   * Retrieves paginated overtime requests scoped by the manager's effective data scope.
   */
  async getScopedRequests(
    actorUserId: string,
    actorUserType: string,
    query: QueryOvertimeRequestsDto,
  ) {
    const { userId, status, startDate, endDate, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    if (userId) {
      await this.accessService.assertSupervisorAccess(
        userId,
        actorUserId,
        actorUserType,
        'attendance.view_overtime',
      );
    }

    const userScopeWhere = await this.usersService.buildDataScopeWhere(
      actorUserId,
      actorUserType,
      'attendance.view_overtime',
    );

    const where: any = {
      user: userScopeWhere,
    };
    if (userId) where.userId = userId;
    if (status) where.status = status;
    if (startDate || endDate) {
      where.attendanceDate = {};
      if (startDate) where.attendanceDate.gte = parseDateOnly(startDate);
      if (endDate) where.attendanceDate.lte = parseDateOnly(endDate);
    }

    const [items, total] = await Promise.all([
      this.prisma.attendanceOvertimeRequest.findMany({
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
      this.prisma.attendanceOvertimeRequest.count({ where }),
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
   * Approves a pending overtime request under the 8-level lock hierarchy and updates attendance totals if a record exists.
   */
  async approveRequest(
    requestId: string,
    actorUserId: string,
    actorUserType: string,
    dto: ApproveOvertimeRequestDto = {},
  ) {
    const request = await this.prisma.attendanceOvertimeRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException(`Overtime request with ID "${requestId}" not found.`);
    }

    // 1. Prevent self-approval
    if (request.userId === actorUserId) {
      throw new ForbiddenException(
        'Self-approval of overtime requests is strictly prohibited.',
      );
    }

    // 2. Enforce supervisor data scope
    await this.accessService.assertSupervisorAccess(
      request.userId,
      actorUserId,
      actorUserType,
      'attendance.approve_overtime',
    );

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      // Find matching attendance record on this date if exists
      const record = await tx.attendanceRecord.findUnique({
        where: {
          unique_user_daily_attendance: {
            userId: request.userId,
            attendanceDate: request.attendanceDate,
          },
        },
        select: { id: true },
      });

      // Level 3-8 Hierarchy Locks:
      if (record) {
        // Strictly follow 8-level lock hierarchy:
        // Level 3 (AttendanceRecord) -> Level 5 (AttendanceOvertimeRequest) -> Level 7 (AttendanceSession) -> Level 8 (AttendanceBreak)
        await this.calculationService.acquireHierarchyLocks(
          tx,
          record.id,
          request.userId,
          request.attendanceDate,
        );
      } else {
        // If no attendance record exists, acquire Level 5 Lock on the request
        await tx.$queryRaw`
          SELECT id FROM attendance_overtime_requests WHERE id = ${requestId} FOR UPDATE
        `;
      }

      // Re-read request state under lock
      const current = await tx.attendanceOvertimeRequest.findUniqueOrThrow({
        where: { id: requestId },
      });

      if (current.status !== OvertimeApprovalStatus.PENDING) {
        throw new BadRequestException(
          `Overtime request is no longer pending (current status: ${current.status}).`,
        );
      }

      const totalRequestedMinutes = Math.floor(
        (current.endTime.getTime() - current.startTime.getTime()) / 60000,
      );
      const approvedMinutes = dto.approvedDurationMinutes ?? totalRequestedMinutes;

      const updated = await tx.attendanceOvertimeRequest.update({
        where: { id: requestId },
        data: {
          status: OvertimeApprovalStatus.APPROVED,
          approvedDurationMinutes: approvedMinutes,
          reviewedByUserId: actorUserId,
          reviewedAt: now,
        },
      });

      // If an attendance record exists, trigger deterministic interval recalculation
      let recalculatedRecord = null;
      if (record) {
        const { record: rec } =
          await this.calculationService.recalculateAndPersist(
            record.id,
            { actorUserId, skipLocking: true },
            tx,
          );
        recalculatedRecord = rec;
      }

      return { updated, recalculatedRecord };
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'ATTENDANCE',
      entityType: 'AttendanceOvertimeRequest',
      entityId: result.updated.id,
      newValues: {
        status: OvertimeApprovalStatus.APPROVED,
        approvedDurationMinutes: result.updated.approvedDurationMinutes,
        reviewedByUserId: actorUserId,
        reviewedAt: now.toISOString(),
      },
    });

    return result.updated;
  }

  /**
   * Rejects a pending overtime request under Level 5 lock.
   */
  async rejectRequest(
    requestId: string,
    actorUserId: string,
    actorUserType: string,
    dto: RejectOvertimeRequestDto = {},
  ) {
    const request = await this.prisma.attendanceOvertimeRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException(`Overtime request with ID "${requestId}" not found.`);
    }

    // 1. Prevent self-rejection / self-review
    if (request.userId === actorUserId) {
      throw new ForbiddenException(
        'Self-approval or self-review of overtime requests is strictly prohibited.',
      );
    }

    // 2. Enforce supervisor data scope
    await this.accessService.assertSupervisorAccess(
      request.userId,
      actorUserId,
      actorUserType,
      'attendance.approve_overtime',
    );

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // Level 5 Lock: AttendanceOvertimeRequest
      await tx.$queryRaw`
        SELECT id FROM attendance_overtime_requests WHERE id = ${requestId} FOR UPDATE
      `;

      const current = await tx.attendanceOvertimeRequest.findUniqueOrThrow({
        where: { id: requestId },
      });

      if (current.status !== OvertimeApprovalStatus.PENDING) {
        throw new BadRequestException(
          `Overtime request is no longer pending (current status: ${current.status}).`,
        );
      }

      return tx.attendanceOvertimeRequest.update({
        where: { id: requestId },
        data: {
          status: OvertimeApprovalStatus.REJECTED,
          reviewedByUserId: actorUserId,
          reviewedAt: now,
        },
      });
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'ATTENDANCE',
      entityType: 'AttendanceOvertimeRequest',
      entityId: updated.id,
      newValues: {
        status: OvertimeApprovalStatus.REJECTED,
        managerNotes: dto.managerNotes,
        reviewedByUserId: actorUserId,
        reviewedAt: now.toISOString(),
      },
    });

    return updated;
  }

  /**
   * Cancels an employee's own pending overtime request under Level 5 lock.
   */
  async cancelRequest(requestId: string, userId: string) {
    const request = await this.prisma.attendanceOvertimeRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException(`Overtime request with ID "${requestId}" not found.`);
    }

    if (request.userId !== userId) {
      throw new ForbiddenException(
        'You can only cancel your own overtime requests.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Level 5 Lock: AttendanceOvertimeRequest
      await tx.$queryRaw`
        SELECT id FROM attendance_overtime_requests WHERE id = ${requestId} FOR UPDATE
      `;

      const current = await tx.attendanceOvertimeRequest.findUniqueOrThrow({
        where: { id: requestId },
      });

      if (current.status !== OvertimeApprovalStatus.PENDING) {
        throw new BadRequestException(
          'Only pending overtime requests can be cancelled.',
        );
      }

      return tx.attendanceOvertimeRequest.update({
        where: { id: requestId },
        data: {
          status: OvertimeApprovalStatus.CANCELLED,
        },
      });
    });

    await this.auditService.logAudit({
      actorUserId: userId,
      action: AuditAction.UPDATE,
      module: 'ATTENDANCE',
      entityType: 'AttendanceOvertimeRequest',
      entityId: updated.id,
      newValues: {
        status: OvertimeApprovalStatus.CANCELLED,
      },
    });

    return updated;
  }
}

