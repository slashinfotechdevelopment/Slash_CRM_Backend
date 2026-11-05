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
import { AttendanceShiftsService } from './attendance-shifts.service';
import {
  AttendanceCorrectionStatus,
  AttendanceSessionStatus,
  AttendanceStatus,
  AuditAction,
  VerificationOutcome,
} from '../../generated/prisma/enums';
import {
  CorrectionType,
  CreateCorrectionRequestDto,
} from './dto/create-correction-request.dto';
import { ApproveCorrectionRequestDto } from './dto/approve-correction-request.dto';
import { RejectCorrectionRequestDto } from './dto/reject-correction-request.dto';
import { QueryCorrectionRequestsDto } from './dto/query-correction-requests.dto';
import {
  createAsiaKolkataDateTime,
  formatDateOnly,
  parseDateOnly,
} from './attendance.utils';
import { hasStrictOverlap, TimeInterval } from './attendance-interval.utils';

@Injectable()
export class AttendanceCorrectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly usersService: UsersService,
    private readonly accessService: AttendanceAccessService,
    private readonly calculationService: AttendanceCalculationService,
    private readonly shiftsService: AttendanceShiftsService,
  ) {}

  /**
   * Submits a new attendance correction request with timestamp and session validation.
   */
  async createRequest(
    userId: string,
    dto: CreateCorrectionRequestDto,
    actorUserId: string,
  ) {
    if (userId !== actorUserId) {
      throw new ForbiddenException(
        'You can only submit attendance correction requests for yourself.',
      );
    }

    const attendanceDate = parseDateOnly(dto.attendanceDate);
    const reqIn = dto.requestedCheckInAt ? new Date(dto.requestedCheckInAt) : null;
    const reqOut = dto.requestedCheckOutAt ? new Date(dto.requestedCheckOutAt) : null;

    if (reqIn && isNaN(reqIn.getTime())) {
      throw new BadRequestException('Invalid requestedCheckInAt timestamp format.');
    }
    if (reqOut && isNaN(reqOut.getTime())) {
      throw new BadRequestException('Invalid requestedCheckOutAt timestamp format.');
    }
    if (reqIn && reqOut && reqIn.getTime() >= reqOut.getTime()) {
      throw new BadRequestException(
        'requestedCheckInAt must be strictly before requestedCheckOutAt.',
      );
    }

    // Ensure AttendanceRecord exists for this date; if not, initialize one
    let record = await this.prisma.attendanceRecord.findUnique({
      where: {
        unique_user_daily_attendance: {
          userId,
          attendanceDate,
        },
      },
    });

    if (!record) {
      // Find shift assignment for user on this date
      const activeShift = await this.shiftsService.getEffectiveShiftForDate(
        userId,
        attendanceDate,
      );
      if (!activeShift) {
        throw new BadRequestException(
          `No active shift assignment found for user on ${dto.attendanceDate}.`,
        );
      }
      const shiftDef = activeShift.shiftDefinition;

      const shiftStart = createAsiaKolkataDateTime(
        dto.attendanceDate,
        shiftDef.startTime,
        false,
      );
      const shiftEnd = createAsiaKolkataDateTime(
        dto.attendanceDate,
        shiftDef.endTime,
        shiftDef.isOvernight,
      );

      record = await this.prisma.attendanceRecord.create({
        data: {
          userId,
          shiftDefinitionId: shiftDef.id,
          attendanceDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          shiftStartTimeSnapshot: shiftStart,
          shiftEndTimeSnapshot: shiftEnd,
          isOvernightSnapshot: shiftDef.isOvernight,
          halfDayThresholdSecondsSnapshot: shiftDef.halfDayThresholdMinutes * 60,
          fullDayThresholdSecondsSnapshot: shiftDef.fullDayThresholdMinutes * 60,
          overtimeThresholdSecondsSnapshot: shiftDef.overtimeThresholdMinutes * 60,
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
      });
    }

    let resolvedSessionId: string | null = dto.attendanceSessionId ?? null;
    let breakCorrectionData: any = null;

    if (dto.correctionType === CorrectionType.INCORRECT_BREAK || dto.attendanceBreakId) {
      if (!dto.attendanceBreakId) {
        throw new BadRequestException('attendanceBreakId is required when correcting a break.');
      }
      if (!dto.requestedBreakStartedAt || !dto.requestedBreakEndedAt) {
        throw new BadRequestException(
          'Both requestedBreakStartedAt and requestedBreakEndedAt are required for break correction.',
        );
      }
      const bStart = new Date(dto.requestedBreakStartedAt);
      const bEnd = new Date(dto.requestedBreakEndedAt);
      if (isNaN(bStart.getTime()) || isNaN(bEnd.getTime())) {
        throw new BadRequestException('Invalid break timestamp format.');
      }
      if (bStart.getTime() >= bEnd.getTime()) {
        throw new BadRequestException(
          'requestedBreakStartedAt must be strictly before requestedBreakEndedAt.',
        );
      }

      // Verify break ownership on record and employee
      const targetBreak = await this.prisma.attendanceBreak.findUnique({
        where: {
          unique_break_record_user_composite: {
            id: dto.attendanceBreakId,
            attendanceRecordId: record.id,
            userId,
          },
        },
      });
      if (!targetBreak) {
        throw new BadRequestException(
          `Attendance break "${dto.attendanceBreakId}" does not belong to this attendance record or user.`,
        );
      }

      // Verify break containment within session
      let session: any = null;
      if (dto.attendanceSessionId) {
        session = await this.prisma.attendanceSession.findUnique({
          where: {
            unique_session_record_user_composite: {
              id: dto.attendanceSessionId,
              attendanceRecordId: record.id,
              userId,
            },
          },
        });
        if (!session) {
          throw new BadRequestException(
            `Attendance session "${dto.attendanceSessionId}" does not belong to this attendance record or user.`,
          );
        }
      } else {
        // Find session on record containing this break
        const sessions = await this.prisma.attendanceSession.findMany({
          where: { attendanceRecordId: record.id, userId },
        });
        session = sessions.find((s) => {
          const sIn = s.checkInAt ?? s.rawCheckInAt;
          const sOut = s.checkOutAt ?? s.rawCheckOutAt;
          return sIn && sOut && sIn.getTime() <= bStart.getTime() && bEnd.getTime() <= sOut.getTime();
        });
      }

      if (!session) {
        throw new BadRequestException(
          'Corrected break must be fully contained within an attendance session on this date.',
        );
      }
      const sIn = session.checkInAt ?? session.rawCheckInAt;
      const sOut = session.checkOutAt ?? session.rawCheckOutAt;
      if (!sIn || !sOut || sIn.getTime() > bStart.getTime() || bEnd.getTime() > sOut.getTime()) {
        throw new BadRequestException(
          'Corrected break must be fully contained within the attendance session.',
        );
      }
      resolvedSessionId = session.id;

      // Prevent overlapping breaks
      const existingBreaks = await this.prisma.attendanceBreak.findMany({
        where: { attendanceRecordId: record.id },
      });
      for (const eb of existingBreaks) {
        if (eb.id !== targetBreak.id) {
          const ebEnd = eb.endedAt ?? new Date();
          if (eb.startedAt.getTime() < bEnd.getTime() && ebEnd.getTime() > bStart.getTime()) {
            throw new BadRequestException(
              'Corrected break interval overlaps with another existing break on this date.',
            );
          }
        }
      }

      breakCorrectionData = {
        attendanceBreakId: targetBreak.id,
        requestedBreakStartedAt: bStart.toISOString(),
        requestedBreakEndedAt: bEnd.toISOString(),
        originalStartedAt: targetBreak.startedAt.toISOString(),
        originalEndedAt: targetBreak.endedAt?.toISOString() ?? null,
      };
    } else if (dto.attendanceSessionId) {
      // Validate session ownership if attendanceSessionId is supplied
      const session = await this.prisma.attendanceSession.findUnique({
        where: {
          unique_session_record_user_composite: {
            id: dto.attendanceSessionId,
            attendanceRecordId: record.id,
            userId,
          },
        },
      });

      if (!session) {
        throw new BadRequestException(
          `Attendance session "${dto.attendanceSessionId}" does not belong to this attendance record or user.`,
        );
      }

      if (dto.correctionType === CorrectionType.MISSED_CHECK_IN && !reqIn) {
        throw new BadRequestException(
          'requestedCheckInAt is required when correcting a missed check-in.',
        );
      }
      if (dto.correctionType === CorrectionType.MISSED_CHECK_OUT && !reqOut) {
        throw new BadRequestException(
          'requestedCheckOutAt is required when correcting a missed check-out.',
        );
      }

      const effIn = reqIn ?? session.checkInAt ?? session.rawCheckInAt;
      const effOut = reqOut ?? session.checkOutAt ?? session.rawCheckOutAt;
      if (effIn && effOut && effIn.getTime() >= effOut.getTime()) {
        throw new BadRequestException(
          'requestedCheckInAt must be strictly before checkOutAt.',
        );
      }
    } else {
      // Missing session: both checkIn and checkOut are strictly required
      if (!reqIn || !reqOut) {
        throw new BadRequestException(
          'Both requestedCheckInAt and requestedCheckOutAt are required when correcting a missing session.',
        );
      }
    }

    // Wrap duplicate check and creation in transaction with Level 3 & Level 4 locks
    const created = await this.prisma.$transaction(async (tx) => {
      // Level 3 Lock: AttendanceRecord
      await tx.$queryRaw`
        SELECT id FROM attendance_records WHERE id = ${record.id} FOR UPDATE
      `;

      // Level 4 Lock: AttendanceCorrectionRequest (locking read prevents concurrent duplicate creation)
      await tx.$queryRaw`
        SELECT id FROM attendance_correction_requests
        WHERE attendance_record_id = ${record.id}
        ORDER BY id ASC
        FOR UPDATE
      `;

      // Check existing pending requests
      const pendingRequests = await tx.attendanceCorrectionRequest.findMany({
        where: {
          attendanceRecordId: record.id,
          userId,
          status: AttendanceCorrectionStatus.PENDING,
        },
      });

      for (const p of pendingRequests) {
        if (breakCorrectionData) {
          const meta = p.evidenceMetadata as any;
          if (meta?.breakCorrection?.attendanceBreakId === breakCorrectionData.attendanceBreakId) {
            throw new ConflictException(
              `A pending correction request (${p.id}) already exists for this break.`,
            );
          }
        } else {
          if (p.attendanceSessionId === resolvedSessionId) {
            throw new ConflictException(
              `A pending correction request (${p.id}) already exists for this attendance session/record.`,
            );
          }
        }
      }

      return tx.attendanceCorrectionRequest.create({
        data: {
          attendanceRecordId: record.id,
          userId,
          attendanceSessionId: resolvedSessionId,
          requestedCheckInAt: reqIn,
          requestedCheckOutAt: reqOut,
          reason: dto.reason.trim(),
          evidenceMetadata: {
            ...dto.evidenceMetadata,
            correctionType: dto.correctionType,
            ...(breakCorrectionData ? { breakCorrection: breakCorrectionData } : {}),
          },
          status: AttendanceCorrectionStatus.PENDING,
        },
        include: {
          session: true,
          attendanceRecord: {
            select: { attendanceDate: true },
          },
        },
      });
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'ATTENDANCE',
      entityType: 'AttendanceCorrectionRequest',
      entityId: created.id,
      newValues: {
        userId,
        attendanceRecordId: record.id,
        attendanceSessionId: dto.attendanceSessionId,
        correctionType: dto.correctionType,
        requestedCheckInAt: reqIn?.toISOString() ?? null,
        requestedCheckOutAt: reqOut?.toISOString() ?? null,
        reason: dto.reason,
        status: AttendanceCorrectionStatus.PENDING,
      },
    });

    return created;
  }

  /**
   * Retrieves an employee's own correction requests.
   */
  async getMyRequests(userId: string, query: QueryCorrectionRequestsDto) {
    const { status, startDate, endDate, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: any = { userId };
    if (status) where.status = status;
    if (startDate || endDate) {
      where.attendanceRecord = { attendanceDate: {} };
      if (startDate) where.attendanceRecord.attendanceDate.gte = parseDateOnly(startDate);
      if (endDate) where.attendanceRecord.attendanceDate.lte = parseDateOnly(endDate);
    }

    const [items, total] = await Promise.all([
      this.prisma.attendanceCorrectionRequest.findMany({
        where,
        include: {
          session: true,
          attendanceRecord: {
            select: { id: true, attendanceDate: true, status: true },
          },
          evidenceVerification: true,
          reviewer: {
            select: { id: true, name: true, email: true, userCode: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.attendanceCorrectionRequest.count({ where }),
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
   * Retrieves paginated correction requests scoped by the manager's effective data scope.
   */
  async getScopedRequests(
    actorUserId: string,
    actorUserType: string,
    query: QueryCorrectionRequestsDto,
  ) {
    const { userId, attendanceRecordId, status, startDate, endDate, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    if (userId) {
      await this.accessService.assertSupervisorAccess(
        userId,
        actorUserId,
        actorUserType,
        'attendance.review_correction',
      );
    }

    const userScopeWhere = await this.usersService.buildDataScopeWhere(
      actorUserId,
      actorUserType,
      'attendance.review_correction',
    );

    const where: any = {
      user: userScopeWhere,
    };
    if (userId) where.userId = userId;
    if (attendanceRecordId) where.attendanceRecordId = attendanceRecordId;
    if (status) where.status = status;
    if (startDate || endDate) {
      where.attendanceRecord = { attendanceDate: {} };
      if (startDate) where.attendanceRecord.attendanceDate.gte = parseDateOnly(startDate);
      if (endDate) where.attendanceRecord.attendanceDate.lte = parseDateOnly(endDate);
    }

    const [items, total] = await Promise.all([
      this.prisma.attendanceCorrectionRequest.findMany({
        where,
        include: {
          user: {
            select: { id: true, name: true, email: true, userCode: true },
          },
          session: true,
          attendanceRecord: {
            select: { id: true, attendanceDate: true, status: true },
          },
          evidenceVerification: true,
          reviewer: {
            select: { id: true, name: true, email: true, userCode: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.attendanceCorrectionRequest.count({ where }),
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
   * Retrieves full details of a specific correction request.
   */
  async getRequestById(
    requestId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    const request = await this.prisma.attendanceCorrectionRequest.findUnique({
      where: { id: requestId },
      include: {
        user: {
          select: { id: true, name: true, email: true, userCode: true },
        },
        session: true,
        attendanceRecord: {
          select: {
            id: true,
            attendanceDate: true,
            status: true,
            grossWorkingDurationSeconds: true,
            netWorkingDurationSeconds: true,
            verifiedOvertimeSeconds: true,
          },
        },
        evidenceVerification: true,
        reviewer: {
          select: { id: true, name: true, email: true, userCode: true },
        },
      },
    });

    if (!request) {
      throw new NotFoundException(
        `Attendance correction request "${requestId}" not found.`,
      );
    }

    // Owner can view; otherwise supervisor must have scope access
    if (request.userId !== actorUserId) {
      await this.accessService.assertSupervisorAccess(
        request.userId,
        actorUserId,
        actorUserType,
        'attendance.review_correction',
      );
    }

    return request;
  }

  /**
   * Cancels an employee's own pending correction request.
   */
  async cancelRequest(requestId: string, actorUserId: string) {
    const request = await this.prisma.attendanceCorrectionRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException(
        `Attendance correction request "${requestId}" not found.`,
      );
    }

    if (request.userId !== actorUserId) {
      throw new ForbiddenException(
        'You can only cancel your own correction requests.',
      );
    }

    if (request.status !== AttendanceCorrectionStatus.PENDING) {
      throw new BadRequestException(
        `Correction request is no longer pending (current status: ${request.status}).`,
      );
    }

    const updated = await this.prisma.attendanceCorrectionRequest.update({
      where: { id: requestId },
      data: {
        status: AttendanceCorrectionStatus.CANCELLED,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'ATTENDANCE',
      entityType: 'AttendanceCorrectionRequest',
      entityId: requestId,
      oldValues: { status: AttendanceCorrectionStatus.PENDING },
      newValues: { status: AttendanceCorrectionStatus.CANCELLED },
    });

    return updated;
  }

  /**
   * Approves a pending correction request under the 8-level lock hierarchy, applies the
   * corrected timestamps transactionally, and triggers deterministic recalculation.
   */
  async approveRequest(
    requestId: string,
    actorUserId: string,
    actorUserType: string,
    dto: ApproveCorrectionRequestDto = {},
  ) {
    const request = await this.prisma.attendanceCorrectionRequest.findUnique({
      where: { id: requestId },
      include: {
        attendanceRecord: true,
      },
    });

    if (!request) {
      throw new NotFoundException(
        `Attendance correction request "${requestId}" not found.`,
      );
    }

    // 1. Strict Anti-Self-Approval Invariant
    if (request.userId === actorUserId) {
      throw new ForbiddenException(
        'Self-approval of attendance correction requests is strictly prohibited.',
      );
    }

    // 2. Data Scope Authorization
    await this.accessService.assertSupervisorAccess(
      request.userId,
      actorUserId,
      actorUserType,
      'attendance.approve_correction',
    );

    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      // 3. Monotonically acquire pessimistic locks:
      // Level 3 (Record) -> Level 4 (CorrectionRequest) -> Level 5 (Overtime) -> Level 7 (Session) -> Level 8 (Break)
      await this.calculationService.acquireHierarchyLocks(
        tx,
        request.attendanceRecordId,
        request.userId,
        request.attendanceRecord.attendanceDate,
      );

      // Re-read request state under lock
      const current = await tx.attendanceCorrectionRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: { session: true },
      });

      if (current.status !== AttendanceCorrectionStatus.PENDING) {
        throw new BadRequestException(
          `Correction request is no longer pending (current status: ${current.status}).`,
        );
      }

      // 4. Apply correction to session(s) or break
      let correctedSessionId = current.attendanceSessionId;
      let previousValues: any = {};
      let newValues: any = {};

      const breakCorr = (current.evidenceMetadata as any)?.breakCorrection;

      if (breakCorr) {
        // Case Break: Correct break start and end
        const targetBreak = await tx.attendanceBreak.findUniqueOrThrow({
          where: { id: breakCorr.attendanceBreakId },
        });

        const bStart = new Date(breakCorr.requestedBreakStartedAt);
        const bEnd = new Date(breakCorr.requestedBreakEndedAt);

        // Re-verify containment within session under lock
        if (current.attendanceSessionId) {
          const session = await tx.attendanceSession.findUniqueOrThrow({
            where: { id: current.attendanceSessionId },
          });
          const sIn = session.checkInAt ?? session.rawCheckInAt;
          const sOut = session.checkOutAt ?? session.rawCheckOutAt;
          if (
            !sIn ||
            !sOut ||
            sIn.getTime() > bStart.getTime() ||
            bEnd.getTime() > sOut.getTime()
          ) {
            throw new BadRequestException(
              'Corrected break must be fully contained within the attendance session.',
            );
          }
        }

        // Re-verify non-overlap with other breaks under lock
        const allBreaks = await tx.attendanceBreak.findMany({
          where: { attendanceRecordId: request.attendanceRecordId },
        });
        for (const eb of allBreaks) {
          if (eb.id !== targetBreak.id) {
            const ebEnd = eb.endedAt ?? new Date();
            if (eb.startedAt.getTime() < bEnd.getTime() && ebEnd.getTime() > bStart.getTime()) {
              throw new BadRequestException(
                'Corrected break interval overlaps with another existing break.',
              );
            }
          }
        }

        previousValues = {
          entityType: 'AttendanceBreak',
          breakId: targetBreak.id,
          startedAt: targetBreak.startedAt.toISOString(),
          endedAt: targetBreak.endedAt?.toISOString() ?? null,
        };

        await tx.attendanceBreak.update({
          where: { id: targetBreak.id },
          data: {
            startedAt: bStart,
            endedAt: bEnd,
          },
        });

        newValues = {
          entityType: 'AttendanceBreak',
          breakId: targetBreak.id,
          startedAt: bStart.toISOString(),
          endedAt: bEnd.toISOString(),
        };
      } else if (current.attendanceSessionId) {
        // Case A: Correct existing session
        const session = await tx.attendanceSession.findUniqueOrThrow({
          where: {
            unique_session_record_user_composite: {
              id: current.attendanceSessionId,
              attendanceRecordId: request.attendanceRecordId,
              userId: request.userId,
            },
          },
        });

        const effectiveCheckIn = current.requestedCheckInAt ?? session.checkInAt ?? session.rawCheckInAt;
        const effectiveCheckOut = current.requestedCheckOutAt ?? session.checkOutAt ?? session.rawCheckOutAt;

        if (effectiveCheckIn && effectiveCheckOut && effectiveCheckIn.getTime() >= effectiveCheckOut.getTime()) {
          throw new BadRequestException(
            'Corrected checkInAt must be strictly before checkOutAt.',
          );
        }

        const durationSeconds = effectiveCheckIn && effectiveCheckOut
          ? Math.max(0, Math.floor((effectiveCheckOut.getTime() - effectiveCheckIn.getTime()) / 1000))
          : null;

        previousValues = {
          entityType: 'AttendanceSession',
          sessionId: session.id,
          checkInAt: session.checkInAt?.toISOString() ?? null,
          checkOutAt: session.checkOutAt?.toISOString() ?? null,
        };

        await tx.attendanceSession.update({
          where: { id: session.id },
          data: {
            checkInAt: effectiveCheckIn,
            checkOutAt: effectiveCheckOut,
            durationSeconds,
            status: effectiveCheckIn && effectiveCheckOut
              ? AttendanceSessionStatus.COMPLETED
              : session.status,
          },
        });

        newValues = {
          entityType: 'AttendanceSession',
          sessionId: session.id,
          checkInAt: effectiveCheckIn?.toISOString() ?? null,
          checkOutAt: effectiveCheckOut?.toISOString() ?? null,
        };
      } else {
        // Case B: Create missing session (e.g. employee forgot check-in and checkout entirely)
        if (!current.requestedCheckInAt || !current.requestedCheckOutAt) {
          throw new BadRequestException(
            'Creating a missing session requires both requestedCheckInAt and requestedCheckOutAt.',
          );
        }

        if (current.requestedCheckInAt.getTime() >= current.requestedCheckOutAt.getTime()) {
          throw new BadRequestException(
            'requestedCheckInAt must be strictly before requestedCheckOutAt.',
          );
        }

        const durationSeconds = Math.max(
          0,
          Math.floor(
            (current.requestedCheckOutAt.getTime() - current.requestedCheckInAt.getTime()) / 1000,
          ),
        );

        const newSession = await tx.attendanceSession.create({
          data: {
            attendanceRecordId: request.attendanceRecordId,
            userId: request.userId,
            rawCheckInAt: current.requestedCheckInAt,
            checkInAt: current.requestedCheckInAt,
            rawCheckOutAt: current.requestedCheckOutAt,
            checkOutAt: current.requestedCheckOutAt,
            durationSeconds,
            status: AttendanceSessionStatus.COMPLETED,
          },
        });
        correctedSessionId = newSession.id;

        previousValues = {
          entityType: 'AttendanceSession',
          sessionId: null,
          createdSession: false,
        };

        newValues = {
          entityType: 'AttendanceSession',
          sessionId: newSession.id,
          checkInAt: current.requestedCheckInAt.toISOString(),
          checkOutAt: current.requestedCheckOutAt.toISOString(),
        };
      }

      // 5. Check for session overlap on this record after correction
      const allSessions = await tx.attendanceSession.findMany({
        where: { attendanceRecordId: request.attendanceRecordId },
      });
      const completedIntervals: TimeInterval[] = allSessions
        .filter((s) => s.checkInAt && s.checkOutAt)
        .map((s) => ({
          start: new Date(s.checkInAt!.getTime()),
          end: new Date(s.checkOutAt!.getTime()),
        }));

      if (hasStrictOverlap(completedIntervals)) {
        throw new BadRequestException(
          'Applying this correction would result in overlapping attendance sessions on this date.',
        );
      }

      // 6. Record Evidence Verification
      const clientRef = (current.evidenceMetadata as any)?.evidenceReference;
      const evidenceRef =
        dto.evidenceReference ||
        clientRef ||
        'Supervisor verified external operational records';

      let outcome = dto.evidenceOutcome ?? VerificationOutcome.VERIFIED;
      // Prevent false verification claim: If reviewer asserts VERIFIED but neither client provided evidence
      // nor reviewer provided an independent evidence reference or explanatory verification notes, downgrade to INCONCLUSIVE.
      if (
        outcome === VerificationOutcome.VERIFIED &&
        !dto.evidenceReference &&
        !clientRef &&
        !dto.verificationNotes
      ) {
        outcome = VerificationOutcome.INCONCLUSIVE;
      }

      const notes =
        dto.verificationNotes ||
        dto.managerNotes ||
        (outcome === VerificationOutcome.VERIFIED
          ? 'Correction approved with verified evidence.'
          : 'Approved with inconclusive external evidence.');

      const verification = await tx.attendanceEvidenceVerification.upsert({
        where: { correctionRequestId: requestId },
        create: {
          correctionRequestId: requestId,
          reviewerUserId: actorUserId,
          evidenceReference: evidenceRef,
          outcome,
          verificationNotes: notes,
          verifiedAt: now,
        },
        update: {
          reviewerUserId: actorUserId,
          evidenceReference: evidenceRef,
          outcome,
          verificationNotes: notes,
          verifiedAt: now,
        },
      });

      // 7. Update Correction Request status to APPROVED
      const updatedRequest = await tx.attendanceCorrectionRequest.update({
        where: { id: requestId },
        data: {
          attendanceSessionId: correctedSessionId,
          status: AttendanceCorrectionStatus.APPROVED,
          reviewedByUserId: actorUserId,
          reviewedAt: now,
          managerNotes: dto.managerNotes || 'Approved by reviewer',
        },
        include: {
          session: true,
          evidenceVerification: true,
        },
      });

      // 8. Trigger Deterministic Recalculation (with skipLocking: true since locks are held)
      const { record: recalculatedRecord, result: calcResult } =
        await this.calculationService.recalculateAndPersist(
          request.attendanceRecordId,
          { actorUserId, skipLocking: true },
          tx,
        );

      return {
        updatedRequest,
        recalculatedRecord,
        calcResult,
        verification,
        previousValues,
        newValues,
      };
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'ATTENDANCE',
      entityType: 'AttendanceCorrectionRequest',
      entityId: requestId,
      oldValues: {
        status: AttendanceCorrectionStatus.PENDING,
        ...result.previousValues,
      },
      newValues: {
        status: AttendanceCorrectionStatus.APPROVED,
        reviewedByUserId: actorUserId,
        reviewedAt: now.toISOString(),
        managerNotes: dto.managerNotes,
        ...result.newValues,
      },
    });

    return result.updatedRequest;
  }

  /**
   * Rejects a pending correction request under Level 4 lock and records evidence outcome.
   */
  async rejectRequest(
    requestId: string,
    actorUserId: string,
    actorUserType: string,
    dto: RejectCorrectionRequestDto,
  ) {
    const request = await this.prisma.attendanceCorrectionRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException(
        `Attendance correction request "${requestId}" not found.`,
      );
    }

    // 1. Strict Anti-Self-Review Invariant
    if (request.userId === actorUserId) {
      throw new ForbiddenException(
        'Self-review or rejection of own correction requests is strictly prohibited.',
      );
    }

    // 2. Data Scope Authorization
    await this.accessService.assertSupervisorAccess(
      request.userId,
      actorUserId,
      actorUserType,
      'attendance.approve_correction',
    );

    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      // Level 4 Lock: AttendanceCorrectionRequest
      await tx.$queryRaw`
        SELECT id FROM attendance_correction_requests WHERE id = ${requestId} FOR UPDATE
      `;

      const current = await tx.attendanceCorrectionRequest.findUniqueOrThrow({
        where: { id: requestId },
      });

      if (current.status !== AttendanceCorrectionStatus.PENDING) {
        throw new BadRequestException(
          `Correction request is no longer pending (current status: ${current.status}).`,
        );
      }

      // Record Evidence Verification outcome
      const evidenceRef =
        (current.evidenceMetadata as any)?.evidenceReference || 'Evidence review';
      const outcome = dto.evidenceOutcome ?? VerificationOutcome.REJECTED;
      const notes = dto.verificationNotes || dto.managerNotes;

      await tx.attendanceEvidenceVerification.upsert({
        where: { correctionRequestId: requestId },
        create: {
          correctionRequestId: requestId,
          reviewerUserId: actorUserId,
          evidenceReference: evidenceRef,
          outcome,
          verificationNotes: notes,
          verifiedAt: now,
        },
        update: {
          reviewerUserId: actorUserId,
          evidenceReference: evidenceRef,
          outcome,
          verificationNotes: notes,
          verifiedAt: now,
        },
      });

      // Update request status to REJECTED
      return tx.attendanceCorrectionRequest.update({
        where: { id: requestId },
        data: {
          status: AttendanceCorrectionStatus.REJECTED,
          reviewedByUserId: actorUserId,
          reviewedAt: now,
          managerNotes: dto.managerNotes.trim(),
        },
        include: {
          session: true,
          evidenceVerification: true,
        },
      });
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'ATTENDANCE',
      entityType: 'AttendanceCorrectionRequest',
      entityId: requestId,
      oldValues: { status: AttendanceCorrectionStatus.PENDING },
      newValues: {
        status: AttendanceCorrectionStatus.REJECTED,
        reviewedByUserId: actorUserId,
        reviewedAt: now.toISOString(),
        managerNotes: dto.managerNotes,
      },
    });

    return result;
  }
}
