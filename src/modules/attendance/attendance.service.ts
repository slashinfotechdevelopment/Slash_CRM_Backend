import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  AttendanceSessionStatus,
  AttendanceStatus,
  AuditAction,
} from '../../generated/prisma/enums';
import { UsersService } from '../users/users.service';
import { AttendanceShiftsService } from './attendance-shifts.service';
import { AttendanceAccessService } from './attendance-access.service';
import { AttendanceCalculationService } from './attendance-calculation.service';
import { CheckInDto } from './dto/check-in.dto';
import { CheckOutDto } from './dto/check-out.dto';
import { EndBreakDto, StartBreakDto } from './dto/start-break.dto';
import { QueryAttendanceHistoryDto } from './dto/query-attendance-history.dto';
import {
  createAsiaKolkataDateTime,
  formatDateOnly,
  getAsiaKolkataDateString,
  getPreviousDayString,
  parseBreakPolicySnapshot,
  parseDateOnly,
} from './attendance.utils';

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly shiftsService: AttendanceShiftsService,
    private readonly accessService: AttendanceAccessService,
    private readonly calculationService: AttendanceCalculationService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Performs server-authoritative employee check-in:
   * - Enforces single active session per employee (database + service level)
   * - Resolves attendance date in Asia/Kolkata timezone with overnight shift support
   * - Resolves effective shift and captures immutable historical snapshots
   * - Enforces multi-session policy via shiftDefinition.allowMultipleSessions
   * - Preserves raw telemetry and authoritative timestamps
   */
  async checkIn(
    userId: string,
    dto: CheckInDto = {},
    actorUserId?: string,
  ) {
    const now = new Date();

    // 1. Guard against pre-existing active session
    const existingActiveSession = await this.prisma.attendanceSession.findFirst({
      where: { userId, status: AttendanceSessionStatus.ACTIVE },
    });
    if (existingActiveSession) {
      throw new ConflictException(
        'An active attendance session already exists. You must check out before starting a new session.',
      );
    }

    // 2. Guard against pre-existing active break
    const existingActiveBreak = await this.prisma.attendanceBreak.findFirst({
      where: { userId, endedAt: null },
    });
    if (existingActiveBreak) {
      throw new ConflictException(
        'You have an ongoing break. Please end the active break before checking in.',
      );
    }

    // 3. Resolve attendance date in Asia/Kolkata timezone
    const localTodayStr = getAsiaKolkataDateString(now);
    let attendanceDateStr = localTodayStr;

    // Overnight shift boundary check:
    // If checking in during early morning hours, check if yesterday was an overnight shift without sessions yet
    const yesterdayStr = getPreviousDayString(localTodayStr);
    const yesterdayShift = await this.shiftsService.getEffectiveShiftForDate(
      userId,
      yesterdayStr,
    );

    if (yesterdayShift && yesterdayShift.shiftDefinition.isOvernight) {
      const yesterdayDate = parseDateOnly(yesterdayStr);
      const yesterdayRecord = await this.prisma.attendanceRecord.findUnique({
        where: {
          unique_user_daily_attendance: {
            userId,
            attendanceDate: yesterdayDate,
          },
        },
        include: {
          sessions: { take: 1 },
        },
      });

      const scheduledEnd = createAsiaKolkataDateTime(
        yesterdayStr,
        yesterdayShift.shiftDefinition.endTime,
        true,
      );
      const graceMs =
        (yesterdayShift.shiftDefinition.autoCloseGraceMinutes ?? 60) *
        60 *
        1000;
      const cutoff = new Date(scheduledEnd.getTime() + graceMs);

      if (
        (!yesterdayRecord || yesterdayRecord.sessions.length === 0) &&
        now.getTime() <= cutoff.getTime()
      ) {
        attendanceDateStr = yesterdayStr;
      }
    }

    const attendanceDate = parseDateOnly(attendanceDateStr);
    const activeShift = await this.shiftsService.getEffectiveShiftForDate(
      userId,
      attendanceDate,
    );

    if (!activeShift) {
      throw new BadRequestException(
        `No active shift assignment found for attendance date ${attendanceDateStr}. Please contact HR.`,
      );
    }
    const shiftDef = activeShift.shiftDefinition;

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // Level 1 Lock: EmployeeProfile
        await tx.$queryRaw`
          SELECT id FROM employee_profiles WHERE user_id = ${userId} FOR UPDATE
        `;

        // Check if AttendanceRecord exists for this date
        let record = await tx.attendanceRecord.findUnique({
          where: {
            unique_user_daily_attendance: {
              userId,
              attendanceDate,
            },
          },
          include: {
            sessions: true,
          },
        });

        if (!record) {
          const shiftStartTimeSnapshot = createAsiaKolkataDateTime(
            attendanceDateStr,
            shiftDef.startTime,
            false,
          );
          const shiftEndTimeSnapshot = createAsiaKolkataDateTime(
            attendanceDateStr,
            shiftDef.endTime,
            shiftDef.isOvernight,
          );

          record = await tx.attendanceRecord.create({
            data: {
              userId,
              shiftAssignmentId: activeShift.id,
              shiftDefinitionId: shiftDef.id,
              attendanceDate,
              status: AttendanceStatus.PENDING_RECONCILIATION,
              shiftStartTimeSnapshot,
              shiftEndTimeSnapshot,
              isOvernightSnapshot: shiftDef.isOvernight,
              halfDayThresholdSecondsSnapshot:
                shiftDef.halfDayThresholdMinutes * 60,
              fullDayThresholdSecondsSnapshot:
                shiftDef.fullDayThresholdMinutes * 60,
              overtimeThresholdSecondsSnapshot:
                shiftDef.overtimeThresholdMinutes * 60,
              allowMultipleSessionsSnapshot: shiftDef.allowMultipleSessions,
              breakPolicySnapshot: (() => {
                try {
                  const p = JSON.parse(shiftDef.breakPolicySnapshot);
                  p.autoCloseGraceMinutes = shiftDef.autoCloseGraceMinutes ?? 30;
                  return JSON.stringify(p);
                } catch {
                  return shiftDef.breakPolicySnapshot;
                }
              })(),
            },
            include: {
              sessions: true,
            },
          });
        } else {
          // Enforce multi-session rule using the immutable daily snapshot
          if (
            !record.allowMultipleSessionsSnapshot &&
            record.sessions.length > 0
          ) {
            throw new ConflictException(
              'Multiple attendance sessions are not permitted for this shift on this date.',
            );
          }
        }

        // Concurrency double-check under lock
        const activeUnderLock = await tx.attendanceSession.findFirst({
          where: { userId, status: AttendanceSessionStatus.ACTIVE },
        });
        if (activeUnderLock) {
          throw new ConflictException(
            'An active attendance session already exists.',
          );
        }

        // Create AttendanceSession
        const session = await tx.attendanceSession.create({
          data: {
            attendanceRecordId: record.id,
            userId,
            rawCheckInAt: now,
            checkInAt: now,
            status: AttendanceSessionStatus.ACTIVE,
          },
        });

        return { record, session };
      });

      await this.auditService.logAudit({
        actorUserId: actorUserId ?? userId,
        action: AuditAction.CREATE,
        module: 'ATTENDANCE',
        entityType: 'AttendanceSession',
        entityId: result.session.id,
        newValues: {
          userId,
          checkInAt: now.toISOString(),
          attendanceDate: attendanceDateStr,
          location: dto.location,
        },
      });

      return {
        session: result.session,
        record: {
          id: result.record.id,
          attendanceDate: formatDateOnly(result.record.attendanceDate),
          status: result.record.status,
          shiftDefinition: {
            code: shiftDef.code,
            name: shiftDef.name,
            startTime: shiftDef.startTime,
            endTime: shiftDef.endTime,
          },
        },
      };
    } catch (error: any) {
      if (
        error.code === 'P2002' &&
        (error.meta?.target?.includes('active_session_user_id') ||
          error.meta?.target?.includes('unique_active_session_per_user'))
      ) {
        throw new ConflictException(
          'Concurrent active session detected. You already have an active session.',
        );
      }
      throw error;
    }
  }

  /**
   * Performs server-authoritative employee check-out:
   * - Prevents check-out without an active session
   * - Prevents check-out during an ongoing active break
   * - Computes authoritative session duration
   * - Recalculates gross working duration, net working duration, and attendance status
   */
  async checkOut(
    userId: string,
    dto: CheckOutDto = {},
    actorUserId?: string,
  ) {
    const now = new Date();

    const activeSession = await this.prisma.attendanceSession.findFirst({
      where: { userId, status: AttendanceSessionStatus.ACTIVE },
      include: {
        attendanceRecord: true,
      },
    });

    if (!activeSession) {
      throw new BadRequestException(
        'No active attendance session found. You must check in before checking out.',
      );
    }

    const activeBreak = await this.prisma.attendanceBreak.findFirst({
      where: { userId, endedAt: null },
    });

    if (activeBreak) {
      throw new BadRequestException(
        'Cannot check out while a break is active. Please end your break first.',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Monotonic Level 3 -> 5 -> 7 -> 8 Lock Acquisition
      await this.calculationService.acquireHierarchyLocks(
        tx,
        activeSession.attendanceRecordId,
        userId,
        activeSession.attendanceRecord.attendanceDate,
      );

      const session = await tx.attendanceSession.findUniqueOrThrow({
        where: { id: activeSession.id },
      });

      if (session.status !== AttendanceSessionStatus.ACTIVE) {
        throw new BadRequestException('Attendance session is no longer active.');
      }

      // Check for active breaks on this record under Level 8 lock
      const activeBreakUnderLock = await tx.attendanceBreak.findFirst({
        where: {
          attendanceRecordId: activeSession.attendanceRecordId,
          endedAt: null,
        },
      });
      if (activeBreakUnderLock) {
        throw new BadRequestException(
          'Cannot check out while a break is active. Please end your break first.',
        );
      }

      const checkInTime = session.checkInAt ?? session.rawCheckInAt;
      const durationSeconds = Math.max(
        0,
        Math.floor((now.getTime() - checkInTime.getTime()) / 1000),
      );

      const updatedSession = await tx.attendanceSession.update({
        where: { id: session.id },
        data: {
          rawCheckOutAt: now,
          checkOutAt: now,
          durationSeconds,
          status: AttendanceSessionStatus.COMPLETED,
        },
      });

      const { record: updatedRecord } =
        await this.calculationService.recalculateAndPersist(
          activeSession.attendanceRecordId,
          { isReconciled: false, actorUserId, skipLocking: true },
          tx,
        );

      return { session: updatedSession, record: updatedRecord };
    });

    await this.auditService.logAudit({
      actorUserId: actorUserId ?? userId,
      action: AuditAction.UPDATE,
      module: 'ATTENDANCE',
      entityType: 'AttendanceSession',
      entityId: result.session.id,
      newValues: {
        userId,
        checkOutAt: now.toISOString(),
        durationSeconds: result.session.durationSeconds,
        status: result.session.status,
      },
    });

    return {
      session: result.session,
      record: {
        id: result.record.id,
        grossWorkingDurationSeconds: result.record.grossWorkingDurationSeconds,
        paidBreakDurationSeconds: result.record.paidBreakDurationSeconds,
        unpaidBreakDurationSeconds: result.record.unpaidBreakDurationSeconds,
        netWorkingDurationSeconds: result.record.netWorkingDurationSeconds,
        status: result.record.status,
      },
    };
  }

  /**
   * Starts an employee break:
   * - Enforces active session prerequisite
   * - Enforces single active break per employee
   * - Validates break type against the shift's immutable break policy snapshot
   */
  async startBreak(
    userId: string,
    dto: StartBreakDto,
    actorUserId?: string,
  ) {
    const now = new Date();

    const activeSession = await this.prisma.attendanceSession.findFirst({
      where: { userId, status: AttendanceSessionStatus.ACTIVE },
      include: {
        attendanceRecord: true,
      },
    });

    if (!activeSession) {
      throw new BadRequestException(
        'Cannot start a break without an active attendance session.',
      );
    }

    const activeBreak = await this.prisma.attendanceBreak.findFirst({
      where: { userId, endedAt: null },
    });

    if (activeBreak) {
      throw new ConflictException(
        'Employee already has an active break. Please end the current break before starting another.',
      );
    }

    const record = activeSession.attendanceRecord;
    const breakPolicy = parseBreakPolicySnapshot(record.breakPolicySnapshot);
    if (!breakPolicy) {
      throw new BadRequestException(
        'Attendance record is missing a valid break policy snapshot.',
      );
    }

    const requestedCode = dto.breakTypeId.trim().toUpperCase();
    const matchedBreakType = breakPolicy.breakTypes.find(
      (bt) => bt.code === requestedCode || bt.breakTypeId === requestedCode,
    );

    if (!matchedBreakType) {
      const allowed = breakPolicy.breakTypes.map((bt) => bt.code).join(', ');
      throw new BadRequestException(
        `Invalid break type "${dto.breakTypeId}". Allowed types for this shift: ${allowed}`,
      );
    }

    try {
      const createdBreak = await this.prisma.$transaction(async (tx) => {
        // Level 3 Lock: AttendanceRecord
        await tx.$queryRaw`
          SELECT id FROM attendance_records WHERE id = ${record.id} FOR UPDATE
        `;

        // Concurrency double-check under lock: verify session is still active
        const sessionUnderLock = await tx.attendanceSession.findFirst({
          where: {
            id: activeSession.id,
            status: AttendanceSessionStatus.ACTIVE,
          },
        });
        if (!sessionUnderLock) {
          throw new BadRequestException(
            'Cannot start a break: the attendance session is no longer active.',
          );
        }

        // Concurrency double-check under lock: verify no active break
        const activeUnderLock = await tx.attendanceBreak.findFirst({
          where: { userId, endedAt: null },
        });
        if (activeUnderLock) {
          throw new ConflictException(
            'Employee already has an active break. Please end the current break before starting another.',
          );
        }

        if (matchedBreakType.maxOccurrencesPerDay) {
          const count = await tx.attendanceBreak.count({
            where: {
              attendanceRecordId: record.id,
              breakTypeId: requestedCode,
            },
          });

          if (count >= matchedBreakType.maxOccurrencesPerDay) {
            throw new BadRequestException(
              `Maximum occurrences (${matchedBreakType.maxOccurrencesPerDay}) reached for break type "${requestedCode}".`,
            );
          }
        }

        return tx.attendanceBreak.create({
          data: {
            attendanceRecordId: record.id,
            userId,
            breakTypeId: requestedCode,
            startedAt: now,
            endedAt: null,
            paidDurationSeconds: 0,
            unpaidDurationSeconds: 0,
          },
        });
      });

      await this.auditService.logAudit({
        actorUserId: actorUserId ?? userId,
        action: AuditAction.CREATE,
        module: 'ATTENDANCE',
        entityType: 'AttendanceBreak',
        entityId: createdBreak.id,
        newValues: {
          userId,
          breakTypeId: requestedCode,
          startedAt: now.toISOString(),
        },
      });

      return createdBreak;
    } catch (error: any) {
      if (
        error instanceof ConflictException ||
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      if (
        error.code === 'P2002' ||
        String(error.message).includes('unique_active_break_per_user') ||
        String(error.meta?.target).includes('unique_active_break_per_user') ||
        String(error.meta?.target).includes('active_break_user_id')
      ) {
        throw new ConflictException(
          'Concurrent active break detected. You already have an active break.',
        );
      }
      throw error;
    }
  }

  /**
   * Concludes an active break:
   * - Enforces active break prerequisite
   * - Computes paid and unpaid break duration chronologically against the shift's allowance
   * - Recalculates net working duration and attendance record totals
   */
  async endBreak(
    userId: string,
    dto: EndBreakDto = {},
    actorUserId?: string,
  ) {
    const now = new Date();

    const activeBreak = await this.prisma.attendanceBreak.findFirst({
      where: { userId, endedAt: null },
      include: {
        attendanceRecord: true,
      },
    });

    if (!activeBreak) {
      throw new BadRequestException('No active break found to end.');
    }

    const record = activeBreak.attendanceRecord;
    const breakPolicy = parseBreakPolicySnapshot(record.breakPolicySnapshot);
    if (!breakPolicy) {
      throw new BadRequestException(
        'Break policy snapshot is invalid or missing.',
      );
    }

    const totalBreakSeconds = Math.max(
      0,
      Math.floor((now.getTime() - activeBreak.startedAt.getTime()) / 1000),
    );

    const totalAllowanceSeconds = (breakPolicy.paidAllowanceMinutes ?? 0) * 60;

    const result = await this.prisma.$transaction(async (tx) => {
      // Monotonic Level 3 -> 5 -> 7 -> 8 Lock Acquisition
      await this.calculationService.acquireHierarchyLocks(
        tx,
        record.id,
        userId,
        record.attendanceDate,
      );

      const currentBreak = await tx.attendanceBreak.findUniqueOrThrow({
        where: { id: activeBreak.id },
      });
      if (currentBreak.endedAt !== null) {
        throw new BadRequestException('Active break has already been concluded.');
      }

      const endedBreak = await tx.attendanceBreak.update({
        where: { id: activeBreak.id },
        data: {
          endedAt: now,
        },
      });

      const { record: updatedRecord, result: calcResult } =
        await this.calculationService.recalculateAndPersist(
          activeBreak.attendanceRecordId,
          { isReconciled: false, actorUserId, skipLocking: true },
          tx,
        );

      const allocation = calcResult.breakAllocations.find(
        (a) => a.breakId === activeBreak.id,
      );

      return {
        endedBreak: {
          ...endedBreak,
          paidDurationSeconds: allocation?.paidDurationSeconds ?? 0,
          unpaidDurationSeconds: allocation?.unpaidDurationSeconds ?? 0,
        },
        record: updatedRecord,
      };
    });

    await this.auditService.logAudit({
      actorUserId: actorUserId ?? userId,
      action: AuditAction.UPDATE,
      module: 'ATTENDANCE',
      entityType: 'AttendanceBreak',
      entityId: result.endedBreak.id,
      newValues: {
        userId,
        endedAt: now.toISOString(),
        paidDurationSeconds: result.endedBreak.paidDurationSeconds,
        unpaidDurationSeconds: result.endedBreak.unpaidDurationSeconds,
      },
    });

    return {
      break: result.endedBreak,
      record: {
        id: result.record.id,
        paidBreakDurationSeconds: result.record.paidBreakDurationSeconds,
        unpaidBreakDurationSeconds: result.record.unpaidBreakDurationSeconds,
        netWorkingDurationSeconds: result.record.netWorkingDurationSeconds,
      },
    };
  }

  /**
   * Retrieves today's full attendance snapshot for the authenticated employee.
   */
  async getTodayAttendance(userId: string) {
    const now = new Date();
    const localTodayStr = getAsiaKolkataDateString(now);

    // 1. Check for open active session or break
    const activeSession = await this.prisma.attendanceSession.findFirst({
      where: { userId, status: AttendanceSessionStatus.ACTIVE },
    });

    const activeBreak = await this.prisma.attendanceBreak.findFirst({
      where: { userId, endedAt: null },
    });

    // 2. Determine target record:
    // If active session exists, use its record; otherwise query by local today date
    let record: any = null;
    if (activeSession) {
      record = await this.prisma.attendanceRecord.findUnique({
        where: { id: activeSession.attendanceRecordId },
        include: {
          shiftDefinition: true,
          sessions: { orderBy: { rawCheckInAt: 'asc' } },
          breaks: { orderBy: { startedAt: 'asc' } },
        },
      });
    } else {
      const todayDate = parseDateOnly(localTodayStr);
      record = await this.prisma.attendanceRecord.findUnique({
        where: {
          unique_user_daily_attendance: {
            userId,
            attendanceDate: todayDate,
          },
        },
        include: {
          shiftDefinition: true,
          sessions: { orderBy: { rawCheckInAt: 'asc' } },
          breaks: { orderBy: { startedAt: 'asc' } },
        },
      });
    }

    const activeShift = await this.shiftsService.getEffectiveShiftForDate(
      userId,
      record ? record.attendanceDate : localTodayStr,
    );

    return {
      date: localTodayStr,
      hasActiveSession: Boolean(activeSession),
      activeSession,
      hasActiveBreak: Boolean(activeBreak),
      activeBreak,
      record: record
        ? {
            id: record.id,
            attendanceDate: formatDateOnly(record.attendanceDate),
            status: record.status,
            grossWorkingDurationSeconds: record.grossWorkingDurationSeconds,
            paidBreakDurationSeconds: record.paidBreakDurationSeconds,
            unpaidBreakDurationSeconds: record.unpaidBreakDurationSeconds,
            netWorkingDurationSeconds: record.netWorkingDurationSeconds,
            verifiedOvertimeSeconds: record.verifiedOvertimeSeconds,
            sessions: record.sessions,
            breaks: record.breaks,
            breakPolicy: parseBreakPolicySnapshot(record.breakPolicySnapshot),
          }
        : null,
      effectiveShift: activeShift
        ? {
            id: activeShift.shiftDefinition.id,
            code: activeShift.shiftDefinition.code,
            name: activeShift.shiftDefinition.name,
            startTime: activeShift.shiftDefinition.startTime,
            endTime: activeShift.shiftDefinition.endTime,
            isOvernight: activeShift.shiftDefinition.isOvernight,
            allowMultipleSessions:
              activeShift.shiftDefinition.allowMultipleSessions,
          }
        : null,
    };
  }

  /**
   * Retrieves paginated attendance history for an employee, verifying supervisor data scopes.
   */
  async getAttendanceHistory(
    query: QueryAttendanceHistoryDto,
    actorUserId: string,
    actorUserType: string,
  ) {
    const targetUserId = query.userId ?? actorUserId;

    // Verify data scope authorization
    await this.accessService.assertSupervisorAccess(
      targetUserId,
      actorUserId,
      actorUserType,
      'attendance.view',
    );

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const where: any = {
      userId: targetUserId,
    };

    if (query.startDate) {
      where.attendanceDate = {
        ...(where.attendanceDate || {}),
        gte: parseDateOnly(query.startDate),
      };
    }

    if (query.endDate) {
      where.attendanceDate = {
        ...(where.attendanceDate || {}),
        lte: parseDateOnly(query.endDate),
      };
    }

    if (query.status) {
      where.status = query.status;
    }

    const [total, records] = await Promise.all([
      this.prisma.attendanceRecord.count({ where }),
      this.prisma.attendanceRecord.findMany({
        where,
        skip,
        take: limit,
        orderBy: { attendanceDate: 'desc' },
        include: {
          shiftDefinition: true,
          sessions: { orderBy: { rawCheckInAt: 'asc' } },
          breaks: { orderBy: { startedAt: 'asc' } },
        },
      }),
    ]);

    const items = records.map((rec) => ({
      id: rec.id,
      userId: rec.userId,
      attendanceDate: formatDateOnly(rec.attendanceDate),
      status: rec.status,
      grossWorkingDurationSeconds: rec.grossWorkingDurationSeconds,
      paidBreakDurationSeconds: rec.paidBreakDurationSeconds,
      unpaidBreakDurationSeconds: rec.unpaidBreakDurationSeconds,
      netWorkingDurationSeconds: rec.netWorkingDurationSeconds,
      verifiedOvertimeSeconds: rec.verifiedOvertimeSeconds,
      hasIntegrityAnomaly: rec.hasIntegrityAnomaly,
      shift: {
        id: rec.shiftDefinition.id,
        code: rec.shiftDefinition.code,
        name: rec.shiftDefinition.name,
        startTime: rec.shiftDefinition.startTime,
        endTime: rec.shiftDefinition.endTime,
      },
      sessions: rec.sessions,
      breaks: rec.breaks,
    }));

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Triggers deterministic recalculation of an attendance record with data scope enforcement.
   */
  async recalculateRecord(
    recordId: string,
    actorUserId: string,
    actorUserType: string,
    options: { isReconciled?: boolean } = {},
  ) {
    const record = await this.prisma.attendanceRecord.findUnique({
      where: { id: recordId },
      include: {
        shiftDefinition: {
          select: { autoCloseGraceMinutes: true },
        },
      },
    });

    if (!record) {
      throw new NotFoundException(
        `Attendance record with ID "${recordId}" not found.`,
      );
    }

    await this.accessService.assertSupervisorAccess(
      record.userId,
      actorUserId,
      actorUserType,
      'attendance.manage_shifts',
    );

    // If client attempts to finalize attendance reconciliation (isReconciled: true):
    if (options.isReconciled) {
      // 1. Authorization: Ordinary shift management does not authorize bypassing reconciliation rules
      const isSuperOrAdmin =
        actorUserType === 'SUPER_ADMIN' || actorUserType === 'ADMIN';
      let hasResolvePermission = false;
      if (!isSuperOrAdmin) {
        const hasRolePermission = await this.prisma.userRole.findFirst({
          where: {
            userId: actorUserId,
            role: {
              permissions: {
                some: {
                  permission: {
                    code: 'attendance.resolve_incident',
                  },
                },
              },
            },
          },
        });
        const hasDirectPermission = await this.prisma.userPermission.findFirst({
          where: {
            userId: actorUserId,
            permission: {
              code: 'attendance.resolve_incident',
            },
            effect: 'ALLOW',
          },
        });
        hasResolvePermission = Boolean(
          hasRolePermission || hasDirectPermission,
        );
      }

      if (!isSuperOrAdmin && !hasResolvePermission) {
        throw new ForbiddenException(
          'Finalizing attendance reconciliation requires attendance.resolve_incident permission or administrative authority.',
        );
      }

      // 2. Cutoff validation: Server-authoritative time must have elapsed past cutoff
      const now = new Date();
      const autoCloseGraceMinutes =
        record.shiftDefinition?.autoCloseGraceMinutes ?? 30;
      const cutoffTimestamp = new Date(
        record.shiftEndTimeSnapshot.getTime() +
          autoCloseGraceMinutes * 60 * 1000,
      );
      if (now.getTime() < cutoffTimestamp.getTime()) {
        throw new BadRequestException(
          'Reconciliation cutoff has not elapsed for this shift. Premature reconciliation is not permitted.',
        );
      }
    }

    return this.calculationService.recalculateAndPersist(recordId, {
      isReconciled: options.isReconciled,
      actorUserId,
    });
  }
}
