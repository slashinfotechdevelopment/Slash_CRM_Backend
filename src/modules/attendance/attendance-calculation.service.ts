import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  AttendanceBreak,
  AttendanceOvertimeRequest,
  AttendanceRecord,
  AttendanceSession,
} from '../../generated/prisma/client';
import {
  AttendanceSessionStatus,
  AttendanceStatus,
  AuditAction,
  OvertimeApprovalStatus,
} from '../../generated/prisma/enums';
import { parseBreakPolicySnapshot } from './attendance.utils';
import {
  hasStrictOverlap,
  intersectIntervals,
  intervalDurationSeconds,
  mergeIntervals,
  subtractIntervals,
  TimeInterval,
  totalDisjointDurationSeconds,
} from './attendance-interval.utils';

export interface BreakAllocationItem {
  breakId: string;
  breakTypeId: string;
  totalDurationSeconds: number;
  paidDurationSeconds: number;
  unpaidDurationSeconds: number;
  isOutsideSession: boolean;
  interval: TimeInterval;
}

export interface CalculationResult {
  grossWorkingDurationSeconds: number;
  paidBreakDurationSeconds: number;
  unpaidBreakDurationSeconds: number;
  netWorkingDurationSeconds: number;
  verifiedOvertimeSeconds: number;
  status: AttendanceStatus;
  hasIntegrityAnomaly: boolean;
  anomalyType: string | null;
  anomalyDetails: string | null;
  hasIncompleteSession: boolean;
  hasIncompleteBreak: boolean;
  breakAllocations: BreakAllocationItem[];
  overtimeIntervals: TimeInterval[];
}

@Injectable()
export class AttendanceCalculationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Deterministically calculates attendance totals, break allocations, verified overtime,
   * and attendance status using persisted records and immutable historical snapshots.
   * This is a pure computation without side-effects.
   */
  computeAttendance(
    record: AttendanceRecord,
    sessions: AttendanceSession[],
    breaks: AttendanceBreak[],
    approvedOvertimes: AttendanceOvertimeRequest[],
    options: { isReconciled?: boolean } = {},
  ): CalculationResult {
    let hasIntegrityAnomaly = false;
    let anomalyType: string | null = null;
    let anomalyDetails: string | null = null;

    const setAnomaly = (type: string, details: string) => {
      if (!hasIntegrityAnomaly) {
        hasIntegrityAnomaly = true;
        anomalyType = type;
        anomalyDetails = details;
      }
    };

    // -------------------------------------------------------------
    // 1. GROSS WORKING DURATION CALCULATION
    // -------------------------------------------------------------
    let hasIncompleteSession = false;
    const completedSessionIntervals: TimeInterval[] = [];

    for (const s of sessions) {
      if (s.status === AttendanceSessionStatus.QUARANTINED || (s as any).isSystemClosed) {
        setAnomaly(
          'OPEN_SESSION',
          `Session ${s.id} was quarantined by reconciliation without an employee check-out.`,
        );
        continue;
      }

      if (
        s.status === AttendanceSessionStatus.ACTIVE ||
        !s.checkOutAt
      ) {
        hasIncompleteSession = true;
        continue;
      }

      const checkInTime = s.checkInAt ?? s.rawCheckInAt;
      const checkOutTime = s.checkOutAt ?? s.rawCheckOutAt;

      if (!checkInTime || !checkOutTime) {
        setAnomaly('MISSING_SESSION_TIMESTAMPS', `Session ${s.id} has missing timestamps.`);
        continue;
      }

      if (checkInTime.getTime() >= checkOutTime.getTime()) {
        setAnomaly(
          'INVALID_SESSION_TIMESTAMPS',
          `Session ${s.id} checkInAt (${checkInTime.toISOString()}) >= checkOutAt (${checkOutTime.toISOString()}).`,
        );
        continue;
      }

      completedSessionIntervals.push({
        start: new Date(checkInTime.getTime()),
        end: new Date(checkOutTime.getTime()),
      });
    }

    // Check for overlapping sessions
    if (hasStrictOverlap(completedSessionIntervals)) {
      setAnomaly(
        'OVERLAPPING_SESSIONS',
        'Overlapping completed attendance sessions detected on the same day.',
      );
    }

    // Merge sessions into disjoint canonical intervals (eliminates double-counting)
    const disjointSessions = mergeIntervals(completedSessionIntervals);
    const grossWorkingDurationSeconds =
      totalDisjointDurationSeconds(disjointSessions);

    // -------------------------------------------------------------
    // 2. BREAK DURATION & CHRONOLOGICAL ALLOCATION
    // -------------------------------------------------------------
    let hasIncompleteBreak = false;
    const completedBreaks: Array<{
      breakRecord: AttendanceBreak;
      interval: TimeInterval;
      rawDuration: number;
    }> = [];

    for (const b of breaks) {
      if ((b as any).isSystemClosed) {
        setAnomaly(
          'OPEN_BREAK',
          `Break ${b.id} was terminated by system reconciliation (no employee punch-out).`,
        );
        continue;
      }

      if (!b.endedAt) {
        hasIncompleteBreak = true;
        setAnomaly(
          'ACTIVE_BREAK_UNRESOLVED',
          `Break ${b.id} has no endedAt timestamp and cannot be allocated.`,
        );
        continue;
      }

      if (b.startedAt.getTime() >= b.endedAt.getTime()) {
        setAnomaly(
          'INVALID_BREAK_TIMESTAMPS',
          `Break ${b.id} startedAt (${b.startedAt.toISOString()}) >= endedAt (${b.endedAt.toISOString()}).`,
        );
        continue;
      }

      const interval: TimeInterval = {
        start: new Date(b.startedAt.getTime()),
        end: new Date(b.endedAt.getTime()),
      };

      completedBreaks.push({
        breakRecord: b,
        interval,
        rawDuration: intervalDurationSeconds(interval),
      });
    }

    // Check for overlapping breaks
    const breakIntervalsOnly = completedBreaks.map((cb) => cb.interval);
    if (hasStrictOverlap(breakIntervalsOnly)) {
      setAnomaly(
        'OVERLAPPING_BREAKS',
        'Multiple breaks overlap in time on this attendance record.',
      );
    }

    // Parse immutable break policy snapshot
    const breakPolicy = parseBreakPolicySnapshot(record.breakPolicySnapshot);
    if (!breakPolicy) {
      setAnomaly(
        'INVALID_BREAK_POLICY_SNAPSHOT',
        'Attendance record is missing a valid break policy snapshot.',
      );
    }

    const totalPaidAllowanceSeconds = breakPolicy
      ? (breakPolicy.paidAllowanceMinutes ?? 0) * 60
      : 0;

    // Chronologically sort completed breaks by start time
    completedBreaks.sort(
      (a, b) => a.interval.start.getTime() - b.interval.start.getTime(),
    );

    const validCompletedSessions = sessions.filter(
      (s) =>
        s.checkInAt &&
        s.checkOutAt &&
        s.checkInAt.getTime() < s.checkOutAt.getTime(),
    );

    let usedPaidAllowanceSeconds = 0;
    const breakAllocations: BreakAllocationItem[] = [];
    const unpaidBreakIntervals: TimeInterval[] = [];

    for (const cb of completedBreaks) {
      // 1. Check for overlap with another completed break
      const isOverlappingWithOtherBreak = completedBreaks.some(
        (other) =>
          other.breakRecord.id !== cb.breakRecord.id &&
          cb.interval.start.getTime() < other.interval.end.getTime() &&
          other.interval.start.getTime() < cb.interval.end.getTime(),
      );

      // 2. Check full containment within a single valid attendance session
      const containingSession = validCompletedSessions.find(
        (s) =>
          s.checkInAt!.getTime() <= cb.interval.start.getTime() &&
          cb.interval.end.getTime() <= s.checkOutAt!.getTime(),
      );

      // 3. Classify specific anomaly if containment fails
      if (!containingSession) {
        const intersectingSessions = validCompletedSessions.filter(
          (s) =>
            s.checkInAt!.getTime() < cb.interval.end.getTime() &&
            cb.interval.start.getTime() < s.checkOutAt!.getTime(),
        );

        if (intersectingSessions.length === 0) {
          setAnomaly(
            'BREAK_OUTSIDE_SESSION',
            `Break ${cb.breakRecord.id} occurred completely outside working sessions.`,
          );
        } else if (intersectingSessions.length > 1) {
          setAnomaly(
            'BREAK_OVERLAPS_MULTIPLE_SESSIONS',
            `Break ${cb.breakRecord.id} spans across multiple distinct working sessions.`,
          );
        } else {
          // Exactly 1 intersecting session, but break starts before check-in or ends after check-out
          const s = intersectingSessions[0];
          if (cb.interval.start.getTime() < s.checkInAt!.getTime()) {
            setAnomaly(
              'BREAK_NOT_CONTAINED_IN_SESSION',
              `Break ${cb.breakRecord.id} started before session check-in time (${s.checkInAt!.toISOString()}).`,
            );
          } else if (cb.interval.end.getTime() > s.checkOutAt!.getTime()) {
            setAnomaly(
              'BREAK_NOT_CONTAINED_IN_SESSION',
              `Break ${cb.breakRecord.id} ended after session check-out time (${s.checkOutAt!.toISOString()}).`,
            );
          }
        }
      }

      if (isOverlappingWithOtherBreak) {
        setAnomaly(
          'OVERLAPPING_BREAKS',
          `Break ${cb.breakRecord.id} overlaps in time with another break.`,
        );
      }

      const isValidBreak =
        Boolean(containingSession) && !isOverlappingWithOtherBreak;

      let paidDurationSeconds = 0;
      let unpaidDurationSeconds = 0;

      if (isValidBreak) {
        // Valid break: allocate paid allowance chronologically
        const effectiveDuration = cb.rawDuration;
        const remainingAllowance = Math.max(
          0,
          totalPaidAllowanceSeconds - usedPaidAllowanceSeconds,
        );

        paidDurationSeconds = Math.min(
          effectiveDuration,
          remainingAllowance,
        );
        unpaidDurationSeconds = Math.max(
          0,
          effectiveDuration - paidDurationSeconds,
        );

        usedPaidAllowanceSeconds += paidDurationSeconds;

        if (unpaidDurationSeconds > 0) {
          const unpaidStart = new Date(
            cb.interval.start.getTime() + paidDurationSeconds * 1000,
          );
          unpaidBreakIntervals.push({
            start: unpaidStart,
            end: cb.interval.end,
          });
        }
      } else {
        // Invalid break: quarantined! Zero out paid/unpaid durations and do not deduct from work
        paidDurationSeconds = 0;
        unpaidDurationSeconds = 0;
      }

      breakAllocations.push({
        breakId: cb.breakRecord.id,
        breakTypeId: cb.breakRecord.breakTypeId,
        totalDurationSeconds: cb.rawDuration,
        paidDurationSeconds,
        unpaidDurationSeconds,
        isOutsideSession: !isValidBreak,
        interval: cb.interval,
      });
    }

    const paidBreakDurationSeconds = usedPaidAllowanceSeconds;
    const unpaidBreakDurationSeconds = breakAllocations.reduce(
      (sum, b) => sum + b.unpaidDurationSeconds,
      0,
    );

    // -------------------------------------------------------------
    // 3. NET WORKING DURATION
    // -------------------------------------------------------------
    // Only unpaid breaks are deducted from gross session duration.
    // Paid breaks are already legitimately included in working hours.
    const netWorkingDurationSeconds = Math.max(
      0,
      grossWorkingDurationSeconds - unpaidBreakDurationSeconds,
    );

    // -------------------------------------------------------------
    // 4. GEOMETRIC OVERTIME CALCULATION
    // -------------------------------------------------------------
    // Actual post-shift work intervals: actual working sessions strictly after shift end time
    const shiftEnd = new Date(record.shiftEndTimeSnapshot.getTime());
    const farFuture = new Date(shiftEnd.getTime() + 7 * 24 * 3600 * 1000); // +7 days
    const postShiftWindow: TimeInterval[] = [{ start: shiftEnd, end: farFuture }];

    const actualPostShiftWork = intersectIntervals(
      disjointSessions,
      postShiftWindow,
    );

    // Approved overtime authorization windows
    const approvedWindows: TimeInterval[] = [];
    for (const ot of approvedOvertimes) {
      if (
        ot.status === OvertimeApprovalStatus.APPROVED &&
        ot.startTime &&
        ot.endTime &&
        ot.startTime.getTime() < ot.endTime.getTime()
      ) {
        const requestedDurationMs =
          ot.endTime.getTime() - ot.startTime.getTime();
        const approvedDurationMs =
          ot.approvedDurationMinutes != null
            ? ot.approvedDurationMinutes * 60 * 1000
            : requestedDurationMs;
        const effectiveEnd = new Date(
          ot.startTime.getTime() +
            Math.min(requestedDurationMs, approvedDurationMs),
        );

        if (ot.startTime.getTime() < effectiveEnd.getTime()) {
          approvedWindows.push({
            start: new Date(ot.startTime.getTime()),
            end: effectiveEnd,
          });
        }
      }
    }

    // Merge approved overtime windows into disjoint union (prevents double-counting)
    const mergedApprovedWindows = mergeIntervals(approvedWindows);

    // Geometric intersection: W_authorized = W_post ∩ U_auth
    const eligibleOvertimeIntervals = intersectIntervals(
      actualPostShiftWork,
      mergedApprovedWindows,
    );

    // Subtract unpaid breaks falling inside the eligible overtime window
    const verifiedOvertimeIntervals = subtractIntervals(
      eligibleOvertimeIntervals,
      unpaidBreakIntervals,
    );

    const verifiedOvertimeSeconds = totalDisjointDurationSeconds(
      verifiedOvertimeIntervals,
    );

    // -------------------------------------------------------------
    // 5. ATTENDANCE STATUS EVALUATION
    // -------------------------------------------------------------
    const fullDayThreshold = record.fullDayThresholdSecondsSnapshot;
    const halfDayThreshold = record.halfDayThresholdSecondsSnapshot;

    // Server-side reconciliation cutoff check using historical immutable snapshot
    const now = new Date();
    const autoCloseGraceMinutes =
      (breakPolicy as any)?.autoCloseGraceMinutes ?? 30;
    const cutoffTimestamp = new Date(
      record.shiftEndTimeSnapshot.getTime() + autoCloseGraceMinutes * 60 * 1000,
    );
    const isCutoffPassed = now.getTime() >= cutoffTimestamp.getTime();
    const effectiveIsReconciled = Boolean(
      options.isReconciled && isCutoffPassed,
    );

    let status = record.status;

    if (hasIntegrityAnomaly) {
      // Data integrity anomalies are quarantined for administrative review
      status = AttendanceStatus.PENDING_RECONCILIATION;
    } else if (hasIncompleteSession || hasIncompleteBreak) {
      // Workday is still actively in progress
      status = AttendanceStatus.PENDING_RECONCILIATION;
    } else {
      if (netWorkingDurationSeconds >= fullDayThreshold) {
        status = AttendanceStatus.PRESENT;
      } else if (netWorkingDurationSeconds >= halfDayThreshold) {
        status = AttendanceStatus.HALF_DAY;
      } else {
        // Absence cutoff rule:
        // Only mark ABSENT if reconciliation has occurred AND server cutoff has passed;
        // otherwise remain PENDING_RECONCILIATION
        if (effectiveIsReconciled) {
          status = AttendanceStatus.ABSENT;
        } else {
          status = AttendanceStatus.PENDING_RECONCILIATION;
        }
      }
    }

    return {
      grossWorkingDurationSeconds,
      paidBreakDurationSeconds,
      unpaidBreakDurationSeconds,
      netWorkingDurationSeconds,
      verifiedOvertimeSeconds,
      status,
      hasIntegrityAnomaly,
      anomalyType,
      anomalyDetails,
      hasIncompleteSession,
      hasIncompleteBreak,
      breakAllocations,
      overtimeIntervals: verifiedOvertimeIntervals,
    };
  }

  /**
   * Monotonically acquires pessimistic locks according to the global hierarchy:
   * Level 3 (AttendanceRecord) -> Level 4 (AttendanceCorrectionRequest) ->
   * Level 5 (AttendanceOvertimeRequest) -> Level 7 (AttendanceSession) -> Level 8 (AttendanceBreak).
   */
  async acquireHierarchyLocks(
    tx: any,
    attendanceRecordId: string,
    userId: string,
    attendanceDate: Date,
  ): Promise<void> {
    // Level 3 Lock: AttendanceRecord
    await tx.$queryRaw`
      SELECT id FROM attendance_records WHERE id = ${attendanceRecordId} FOR UPDATE
    `;

    // Level 4 Lock: AttendanceCorrectionRequest (ordered by id ASC)
    await tx.$queryRaw`
      SELECT id FROM attendance_correction_requests
      WHERE attendance_record_id = ${attendanceRecordId}
      ORDER BY id ASC
      FOR UPDATE
    `;

    // Level 5 Lock: AttendanceOvertimeRequest (ordered by id ASC)
    await tx.$queryRaw`
      SELECT id FROM attendance_overtime_requests
      WHERE user_id = ${userId} AND attendance_date = ${attendanceDate}
      ORDER BY id ASC
      FOR UPDATE
    `;

    // Level 7 Lock: AttendanceSession (ordered by id ASC)
    await tx.$queryRaw`
      SELECT id FROM attendance_sessions
      WHERE attendance_record_id = ${attendanceRecordId}
      ORDER BY id ASC
      FOR UPDATE
    `;

    // Level 8 Lock: AttendanceBreak (ordered by id ASC)
    await tx.$queryRaw`
      SELECT id FROM attendance_breaks
      WHERE attendance_record_id = ${attendanceRecordId}
      ORDER BY id ASC
      FOR UPDATE
    `;
  }

  /**
   * Recalculates an attendance record under an ACID transaction adhering strictly
   * to the global 8-level lock hierarchy:
   * Level 3 (AttendanceRecord) -> Level 5 (AttendanceOvertimeRequest) ->
   * Level 7 (AttendanceSession) -> Level 8 (AttendanceBreak).
   *
   * Updates persisted totals and individual break allocations idempotently.
   * Generates audit log only when values have genuinely changed.
   */
  async recalculateAndPersist(
    attendanceRecordId: string,
    options: {
      isReconciled?: boolean;
      actorUserId?: string;
      skipLocking?: boolean;
    } = {},
    existingTx?: any,
  ): Promise<{
    updated: boolean;
    record: AttendanceRecord;
    result: CalculationResult;
  }> {
    // Pre-flight read to fetch identifiers
    const initial = await (existingTx || this.prisma).attendanceRecord.findUnique({
      where: { id: attendanceRecordId },
      select: { id: true, userId: true, attendanceDate: true },
    });

    if (!initial) {
      throw new NotFoundException(
        `AttendanceRecord with ID "${attendanceRecordId}" not found.`,
      );
    }

    const runWithTx = async (tx: any) => {
      if (!options.skipLocking) {
        await this.acquireHierarchyLocks(
          tx,
          attendanceRecordId,
          initial.userId,
          initial.attendanceDate,
        );
      }

      // Read locked records under transaction (recalculation uses immutable historical snapshots only)
      const record = await tx.attendanceRecord.findUniqueOrThrow({
        where: { id: attendanceRecordId },
      });

      const sessions = await tx.attendanceSession.findMany({
        where: { attendanceRecordId },
        orderBy: { rawCheckInAt: 'asc' },
      });

      const breaks = await tx.attendanceBreak.findMany({
        where: { attendanceRecordId },
        orderBy: { startedAt: 'asc' },
      });

      const approvedOvertimes = await tx.attendanceOvertimeRequest.findMany({
        where: {
          userId: record.userId,
          attendanceDate: record.attendanceDate,
          status: OvertimeApprovalStatus.APPROVED,
        },
        orderBy: { startTime: 'asc' },
      });

      // Execute deterministic calculation
      const result = this.computeAttendance(
        record,
        sessions,
        breaks,
        approvedOvertimes,
        options,
      );

      // Synchronize individual session durationSeconds
      for (const s of sessions) {
        if (s.checkInAt && s.checkOutAt) {
          const dur = Math.max(
            0,
            Math.floor(
              (s.checkOutAt.getTime() - s.checkInAt.getTime()) / 1000,
            ),
          );
          if (s.durationSeconds !== dur) {
            await tx.attendanceSession.update({
              where: { id: s.id },
              data: { durationSeconds: dur },
            });
          }
        }
      }

      // Synchronize individual break allocations
      for (const alloc of result.breakAllocations) {
        const b = breaks.find((item: AttendanceBreak) => item.id === alloc.breakId);
        if (
          b &&
          (b.paidDurationSeconds !== alloc.paidDurationSeconds ||
            b.unpaidDurationSeconds !== alloc.unpaidDurationSeconds)
        ) {
          await tx.attendanceBreak.update({
            where: { id: alloc.breakId },
            data: {
              paidDurationSeconds: alloc.paidDurationSeconds,
              unpaidDurationSeconds: alloc.unpaidDurationSeconds,
            },
          });
        }
      }

      // Check if AttendanceRecord totals or status changed
      const hasChanged =
        record.grossWorkingDurationSeconds !==
          result.grossWorkingDurationSeconds ||
        record.paidBreakDurationSeconds !== result.paidBreakDurationSeconds ||
        record.unpaidBreakDurationSeconds !==
          result.unpaidBreakDurationSeconds ||
        record.netWorkingDurationSeconds !==
          result.netWorkingDurationSeconds ||
        record.verifiedOvertimeSeconds !== result.verifiedOvertimeSeconds ||
        record.status !== result.status ||
        record.hasIntegrityAnomaly !== result.hasIntegrityAnomaly ||
        record.anomalyType !== result.anomalyType;

      let finalRecord = record;

      if (hasChanged) {
        finalRecord = await tx.attendanceRecord.update({
          where: { id: record.id },
          data: {
            grossWorkingDurationSeconds: result.grossWorkingDurationSeconds,
            paidBreakDurationSeconds: result.paidBreakDurationSeconds,
            unpaidBreakDurationSeconds: result.unpaidBreakDurationSeconds,
            netWorkingDurationSeconds: result.netWorkingDurationSeconds,
            verifiedOvertimeSeconds: result.verifiedOvertimeSeconds,
            status: result.status,
            hasIntegrityAnomaly: result.hasIntegrityAnomaly,
            anomalyType: result.anomalyType,
            anomalyDetails: result.anomalyDetails,
            version: { increment: 1 },
          },
        });

        await this.auditService.logAudit({
          actorUserId: options.actorUserId ?? record.userId,
          action: AuditAction.UPDATE,
          module: 'ATTENDANCE',
          entityType: 'AttendanceRecord',
          entityId: record.id,
          oldValues: {
            grossWorkingDurationSeconds: record.grossWorkingDurationSeconds,
            paidBreakDurationSeconds: record.paidBreakDurationSeconds,
            unpaidBreakDurationSeconds: record.unpaidBreakDurationSeconds,
            netWorkingDurationSeconds: record.netWorkingDurationSeconds,
            verifiedOvertimeSeconds: record.verifiedOvertimeSeconds,
            status: record.status,
            hasIntegrityAnomaly: record.hasIntegrityAnomaly,
          },
          newValues: {
            grossWorkingDurationSeconds:
              finalRecord.grossWorkingDurationSeconds,
            paidBreakDurationSeconds: finalRecord.paidBreakDurationSeconds,
            unpaidBreakDurationSeconds: finalRecord.unpaidBreakDurationSeconds,
            netWorkingDurationSeconds: finalRecord.netWorkingDurationSeconds,
            verifiedOvertimeSeconds: finalRecord.verifiedOvertimeSeconds,
            status: finalRecord.status,
            hasIntegrityAnomaly: finalRecord.hasIntegrityAnomaly,
          },
        });
      }

      return {
        updated: hasChanged,
        record: finalRecord,
        result,
      };
    };

    if (existingTx) {
      return runWithTx(existingTx);
    }
    return this.prisma.$transaction(async (tx) => runWithTx(tx));
  }
}
