import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { UsersService } from '../users/users.service';
import { AttendanceAccessService } from './attendance-access.service';
import { AttendanceCalculationService } from './attendance-calculation.service';
import { parseDateOnly } from './attendance.utils';
import {
  AnomalyStatus,
  AttendanceSessionStatus,
  AttendanceStatus,
  AuditAction,
  ReconciliationRunStatus,
} from '../../generated/prisma/enums';
import { TriggerReconciliationDto } from './dto/trigger-reconciliation.dto';
import { QueryReconciliationRunsDto } from './dto/query-reconciliation-runs.dto';
import { QueryAnomaliesDto } from './dto/query-anomalies.dto';
import {
  AnomalyResolutionAction,
  ResolveAnomalyDto,
} from './dto/resolve-anomaly.dto';

/**
 * Deadlock and transaction lock conflict retry helper.
 * Handles MySQL error 1213 (Deadlock found) and 1205 (Lock wait timeout exceeded).
 */
export async function withDeadlockRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 50,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const isDeadlockOrTimeout =
        err?.code === 'P2034' ||
        err?.meta?.code === '1213' ||
        err?.meta?.code === '1205' ||
        err?.message?.includes('Deadlock') ||
        err?.message?.includes('Lock wait timeout') ||
        (typeof err?.code === 'string' && err.code.includes('1213'));

      if (isDeadlockOrTimeout && attempt <= maxRetries) {
        const jitter = Math.floor(Math.random() * 50);
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelayMs * attempt + jitter),
        );
        continue;
      }
      throw err;
    }
  }
}

function hasStrictOverlap(intervals: Array<{ start: Date; end: Date }>): boolean {
  if (intervals.length <= 1) return false;
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].end.getTime() > sorted[i + 1].start.getTime()) {
      return true;
    }
  }
  return false;
}

@Injectable()
export class AttendanceReconciliationService {
  private readonly logger = new Logger(AttendanceReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly usersService: UsersService,
    private readonly accessService: AttendanceAccessService,
    private readonly calculationService: AttendanceCalculationService,
  ) {}

  /**
   * Triggers authoritative server-side End-of-Day (EOD) attendance reconciliation
   * for a target calendar date (Asia/Kolkata business date).
   *
   * Enforces:
   * - Scheduled shift end + auto-close grace period cutoff validation.
   * - Force reconciliation authorization (attendance.force_reconcile) with mandatory reason.
   * - Monotonic lock hierarchy: Level 3 -> 4 -> 5 -> 7 -> 8.
   * - Identification, multi-anomaly persistence, and quarantine of missing punches, open sessions/breaks.
   * - Idempotent re-run safety and historical traceability.
   */
  async executeReconciliation(
    dto: TriggerReconciliationDto,
    actorUserId: string,
    actorUserType?: string,
  ) {
    const targetDate = parseDateOnly(dto.targetDate);
    const now = new Date();

    // 1. Force Reconciliation Authorization & Reason Validation
    if (dto.forceReconcile) {
      if (!dto.forceReason || dto.forceReason.trim().length < 5) {
        throw new BadRequestException(
          'forceReason is required and must be at least 5 characters when forceReconcile is enabled.',
        );
      }

      const hasForcePermission = await this.accessService.hasPermission(
        actorUserId,
        actorUserType ?? '',
        'attendance.force_reconcile',
      );

      if (!hasForcePermission) {
        throw new ForbiddenException(
          'Forbidden: Actor lacks the "attendance.force_reconcile" permission to bypass shift cutoffs.',
        );
      }
    }

    // 2. Fetch eligible candidate records on targetDate
    const recordWhere: any = {
      attendanceDate: targetDate,
    };
    if (dto.departmentId) {
      recordWhere.user = {
        departments: {
          some: { departmentId: dto.departmentId },
        },
      };
    }

    const candidateRecords = await this.prisma.attendanceRecord.findMany({
      where: recordWhere,
      orderBy: { id: 'asc' },
    });

    // 3. Before-cutoff validation:
    // If candidate records exist, inspect whether shift cutoffs have elapsed.
    if (candidateRecords.length > 0 && !dto.forceReconcile) {
      let allBeforeCutoff = true;
      let earliestCutoff: Date | null = null;

      for (const rec of candidateRecords) {
        let graceMinutes = 30;
        try {
          const bp = JSON.parse(rec.breakPolicySnapshot);
          if (bp && typeof bp.autoCloseGraceMinutes === 'number') {
            graceMinutes = bp.autoCloseGraceMinutes;
          }
        } catch {
          // default 30
        }

        const cutoff = new Date(
          rec.shiftEndTimeSnapshot.getTime() + graceMinutes * 60 * 1000,
        );

        if (earliestCutoff === null || cutoff.getTime() < earliestCutoff.getTime()) {
          earliestCutoff = cutoff;
        }

        if (now.getTime() >= cutoff.getTime()) {
          allBeforeCutoff = false;
        }
      }

      if (allBeforeCutoff && earliestCutoff) {
        throw new BadRequestException(
          `Cannot reconcile attendance before shift cutoff has passed (Earliest cutoff: ${earliestCutoff.toISOString()}). Use forceReconcile with required justification and permission to override.`,
        );
      }
    }

    // 4. Create AttendanceReconciliationRun audit entity
    const run = await this.prisma.attendanceReconciliationRun.create({
      data: {
        targetDate,
        departmentId: dto.departmentId ?? null,
        status: ReconciliationRunStatus.IN_PROGRESS,
        triggeredByUserId: actorUserId,
        notes: dto.notes ?? (dto.forceReconcile ? `FORCED: ${dto.forceReason}` : null),
      },
    });

    // 5. Log audit trail for forced reconciliation if applicable
    if (dto.forceReconcile) {
      await this.auditService.logAudit({
        actorUserId,
        action: AuditAction.CREATE,
        module: 'ATTENDANCE',
        entityType: 'AttendanceReconciliationRun',
        entityId: run.id,
        oldValues: { forceReconcile: false },
        newValues: {
          forceReconcile: true,
          forceReason: dto.forceReason,
          targetDate: dto.targetDate,
          candidateCount: candidateRecords.length,
        },
      });
    }

    let totalReconciled = 0;
    let totalQuarantined = 0;
    let totalErrors = 0;
    const errors: any[] = [];

    // 6. Process each candidate record under ACID isolation with deadlock retry
    for (const initialRec of candidateRecords) {
      try {
        await withDeadlockRetry(async () => {
          await this.prisma.$transaction(async (tx) => {
            // Monotonic Lock Acquisition:
            // Level 3 Lock: AttendanceRecord
            // Level 4 Lock: AttendanceCorrectionRequest
            // Level 5 Lock: AttendanceOvertimeRequest
            // Level 7 Lock: AttendanceSession
            // Level 8 Lock: AttendanceBreak
            await this.calculationService.acquireHierarchyLocks(
              tx,
              initialRec.id,
              initialRec.userId,
              initialRec.attendanceDate,
            );

            // Re-read fresh record and related entities under lock
            const record = await tx.attendanceRecord.findUniqueOrThrow({
              where: { id: initialRec.id },
            });

            // Inspect Cutoff for this specific record
            let autoCloseGraceMinutes = 30;
            try {
              const bp = JSON.parse(record.breakPolicySnapshot);
              if (bp && typeof bp.autoCloseGraceMinutes === 'number') {
                autoCloseGraceMinutes = bp.autoCloseGraceMinutes;
              }
            } catch {
              // default 30
            }

            const cutoffTime = new Date(
              record.shiftEndTimeSnapshot.getTime() +
                autoCloseGraceMinutes * 60 * 1000,
            );
            const isCutoffElapsed = now.getTime() >= cutoffTime.getTime();

            if (!isCutoffElapsed && !dto.forceReconcile) {
              // Skip records whose shift has not concluded yet
              return;
            }

            // Read sessions and breaks under lock
            const sessions = await tx.attendanceSession.findMany({
              where: { attendanceRecordId: record.id },
              orderBy: { rawCheckInAt: 'asc' },
            });

            const breaks = await tx.attendanceBreak.findMany({
              where: { attendanceRecordId: record.id },
              orderBy: { startedAt: 'asc' },
            });

            // -------------------------------------------------------------
            // MULTI-ANOMALY DETECTION ENGINE
            // -------------------------------------------------------------
            const detectedAnomalies: Array<{ type: string; details: string }> = [];

            // Anomaly Case 1: Missing Check-in
            if (sessions.length === 0) {
              detectedAnomalies.push({
                type: 'MISSING_CHECK_IN',
                details: 'No attendance check-in punches recorded for scheduled shift.',
              });
            }

            // Anomaly Case 2: Open Break (break left active at EOD)
            const openBreaks = breaks.filter((b) => b.endedAt === null);
            for (const openBreak of openBreaks) {
              detectedAnomalies.push({
                type: 'OPEN_BREAK',
                details: `Break ${openBreak.id} was not ended before end-of-day cutoff.`,
              });
              // Safe Technical Closure:
              // - Release activeBreakUserId virtual lock
              // - Preserve rawEndedAt as NULL (raw telemetry preserved, never fabricated)
              // - Record isSystemClosed = true and systemClosureReason
              // - Award zero duration
              await tx.attendanceBreak.update({
                where: { id: openBreak.id },
                data: {
                  endedAt: openBreak.startedAt,
                  rawEndedAt: null,
                  isSystemClosed: true,
                  systemClosureReason: 'EOD_RECONCILIATION_AUTO_CLOSE',
                  paidDurationSeconds: 0,
                  unpaidDurationSeconds: 0,
                },
              });
            }

            // Anomaly Case 3: Open Session (session still marked ACTIVE at EOD)
            const openActiveSessions = sessions.filter(
              (s) => s.status === AttendanceSessionStatus.ACTIVE,
            );
            for (const openActiveSession of openActiveSessions) {
              detectedAnomalies.push({
                type: 'OPEN_SESSION',
                details: `Session ${openActiveSession.id} was left open without checkout past cutoff.`,
              });
              // Safe Quarantine:
              // - Release activeSessionUserId virtual lock
              // - Preserve rawCheckInAt, rawCheckOutAt remains NULL (no fabricated punch)
              // - checkOutAt remains NULL, durationSeconds = 0, do NOT mark PRESENT
              await tx.attendanceSession.update({
                where: { id: openActiveSession.id },
                data: {
                  status: AttendanceSessionStatus.QUARANTINED,
                  isSystemClosed: true,
                  systemClosureReason: 'EOD_RECONCILIATION_QUARANTINE',
                  checkOutAt: null,
                  durationSeconds: 0,
                },
              });
            }

            // Anomaly Case 4: Missing Check-Out (check-in present, but check-out timestamp is missing)
            const missingCheckoutSessions = sessions.filter(
              (s) =>
                s.rawCheckInAt !== null &&
                s.rawCheckOutAt === null &&
                s.status !== AttendanceSessionStatus.ACTIVE &&
                !openActiveSessions.some((oas) => oas.id === s.id),
            );
            for (const missingCheckoutSession of missingCheckoutSessions) {
              detectedAnomalies.push({
                type: 'MISSING_CHECK_OUT',
                details: `Session ${missingCheckoutSession.id} has check-in punch but check-out punch is missing.`,
              });
              if (missingCheckoutSession.status !== AttendanceSessionStatus.QUARANTINED) {
                await tx.attendanceSession.update({
                  where: { id: missingCheckoutSession.id },
                  data: {
                    status: AttendanceSessionStatus.QUARANTINED,
                    isSystemClosed: true,
                    systemClosureReason: 'EOD_RECONCILIATION_MISSING_CHECKOUT',
                    checkOutAt: null,
                    durationSeconds: 0,
                  },
                });
              }
            }

            // Anomaly Case 5: Invalid Break Interval (e.g. startedAt >= endedAt)
            const invalidBreaks = breaks.filter(
              (b) => b.endedAt !== null && b.startedAt.getTime() >= b.endedAt.getTime(),
            );
            for (const ib of invalidBreaks) {
              detectedAnomalies.push({
                type: 'INVALID_BREAK_INTERVAL',
                details: `Break ${ib.id} startedAt (${ib.startedAt.toISOString()}) >= endedAt (${ib.endedAt!.toISOString()}).`,
              });
            }

            // Anomaly Case 6: Shift or Policy Configuration Discrepancy
            if (
              !record.isOvernightSnapshot &&
              record.shiftStartTimeSnapshot.getTime() >=
                record.shiftEndTimeSnapshot.getTime()
            ) {
              detectedAnomalies.push({
                type: 'POLICY_OR_SHIFT_CONFIGURATION_ISSUE',
                details:
                  'Shift start time is equal to or later than shift end time on non-overnight shift snapshot.',
              });
            }

            // Anomaly Case 7: Overlapping Sessions Check
            const completedIntervals = sessions
              .filter(
                (s) =>
                  s.status === AttendanceSessionStatus.COMPLETED &&
                  s.checkInAt &&
                  s.checkOutAt &&
                  !s.isSystemClosed,
              )
              .map((s) => ({ start: s.checkInAt!, end: s.checkOutAt! }));

            if (hasStrictOverlap(completedIntervals)) {
              detectedAnomalies.push({
                type: 'OVERLAPPING_SESSIONS',
                details: 'Overlapping completed attendance sessions detected on the same day.',
              });
            }

            // -------------------------------------------------------------
            // ANOMALY PERSISTENCE & CLASSIFICATION
            // -------------------------------------------------------------
            if (detectedAnomalies.length > 0) {
              // Persist every detected anomaly in attendance_anomalies table idempotently
              for (const anomaly of detectedAnomalies) {
                const existingActive = await tx.attendanceAnomaly.findFirst({
                  where: {
                    attendanceRecordId: record.id,
                    anomalyType: anomaly.type,
                    status: AnomalyStatus.ACTIVE,
                  },
                });

                if (!existingActive) {
                  await tx.attendanceAnomaly.create({
                    data: {
                      attendanceRecordId: record.id,
                      reconciliationRunId: run.id,
                      anomalyType: anomaly.type,
                      details: anomaly.details,
                      status: AnomalyStatus.ACTIVE,
                      detectedAt: now,
                    },
                  });
                }
              }

              const primaryAnomaly = detectedAnomalies[0];
              const combinedDetails = detectedAnomalies
                .map((a) => `[${a.type}] ${a.details}`)
                .join('; ');

              await tx.attendanceRecord.update({
                where: { id: record.id },
                data: {
                  hasIntegrityAnomaly: true,
                  anomalyType: primaryAnomaly.type,
                  anomalyDetails: combinedDetails,
                  anomalyDetectedAt: now,
                  reconciliationRunId: run.id,
                  status: AttendanceStatus.PENDING_RECONCILIATION,
                  version: { increment: 1 },
                },
              });

              await this.auditService.logAudit({
                actorUserId,
                action: AuditAction.UPDATE,
                module: 'ATTENDANCE',
                entityType: 'AttendanceRecord',
                entityId: record.id,
                oldValues: {
                  status: record.status,
                  hasIntegrityAnomaly: record.hasIntegrityAnomaly,
                },
                newValues: {
                  status: AttendanceStatus.PENDING_RECONCILIATION,
                  hasIntegrityAnomaly: true,
                  anomalyType: primaryAnomaly.type,
                  anomalyDetails: combinedDetails,
                  reconciliationRunId: run.id,
                  detectedAnomalyCount: detectedAnomalies.length,
                },
              });

              totalQuarantined++;
            } else {
              // Clean attendance: recalculate authoritative metrics
              let calcResult: any;
              try {
                calcResult = await this.calculationService.recalculateAndPersist(
                  record.id,
                  {
                    isReconciled: true,
                    actorUserId,
                    skipLocking: true,
                  },
                  tx,
                );
              } catch (calcErr: any) {
                // Calculation engine failure
                const failureAnomaly = {
                  type: 'ATTENDANCE_CALCULATION_FAILURE',
                  details: `Calculation engine threw unexpected error: ${calcErr.message}`,
                };

                await tx.attendanceAnomaly.create({
                  data: {
                    attendanceRecordId: record.id,
                    reconciliationRunId: run.id,
                    anomalyType: failureAnomaly.type,
                    details: failureAnomaly.details,
                    status: AnomalyStatus.ACTIVE,
                    detectedAt: now,
                  },
                });

                await tx.attendanceRecord.update({
                  where: { id: record.id },
                  data: {
                    hasIntegrityAnomaly: true,
                    anomalyType: failureAnomaly.type,
                    anomalyDetails: failureAnomaly.details,
                    reconciliationRunId: run.id,
                    anomalyDetectedAt: now,
                    status: AttendanceStatus.PENDING_RECONCILIATION,
                  },
                });

                totalQuarantined++;
                return;
              }

              // If calculation engine detected internal anomalies (e.g. OVERLAPPING_SESSIONS)
              if (calcResult.result.hasIntegrityAnomaly) {
                const engineAnomalyType =
                  calcResult.result.anomalyType || 'ATTENDANCE_CALCULATION_FAILURE';
                const engineDetails =
                  calcResult.result.anomalyDetails ||
                  'Calculation engine reported an internal integrity anomaly.';

                const existing = await tx.attendanceAnomaly.findFirst({
                  where: {
                    attendanceRecordId: record.id,
                    anomalyType: engineAnomalyType,
                    status: AnomalyStatus.ACTIVE,
                  },
                });

                if (!existing) {
                  await tx.attendanceAnomaly.create({
                    data: {
                      attendanceRecordId: record.id,
                      reconciliationRunId: run.id,
                      anomalyType: engineAnomalyType,
                      details: engineDetails,
                      status: AnomalyStatus.ACTIVE,
                      detectedAt: now,
                    },
                  });
                }

                await tx.attendanceRecord.update({
                  where: { id: record.id },
                  data: {
                    reconciliationRunId: run.id,
                    anomalyDetectedAt: now,
                    status: AttendanceStatus.PENDING_RECONCILIATION,
                  },
                });
                totalQuarantined++;
              } else {
                // If clean and reconciled, transition any previous active anomalies to RESOLVED
                await tx.attendanceAnomaly.updateMany({
                  where: {
                    attendanceRecordId: record.id,
                    status: AnomalyStatus.ACTIVE,
                  },
                  data: {
                    status: AnomalyStatus.RESOLVED,
                    resolvedAt: now,
                    resolvedByUserId: actorUserId,
                    resolutionNotes:
                      'Resolved automatically by clean reconciliation recalculation.',
                  },
                });

                await tx.attendanceRecord.update({
                  where: { id: record.id },
                  data: {
                    reconciledAt: now,
                    reconciliationRunId: run.id,
                    hasIntegrityAnomaly: false,
                    anomalyType: null,
                    anomalyDetails: null,
                  },
                });
                totalReconciled++;
              }
            }
          });
        });
      } catch (err: any) {
        this.logger.error(
          `Failed reconciling record ${initialRec.id}: ${err.message}`,
          err.stack,
        );
        totalErrors++;
        errors.push({ recordId: initialRec.id, error: err.message });
      }
    }

    // 7. Finalize run status
    const finalStatus =
      totalErrors > 0 && totalReconciled + totalQuarantined > 0
        ? ReconciliationRunStatus.PARTIAL
        : totalErrors > 0
          ? ReconciliationRunStatus.FAILED
          : ReconciliationRunStatus.COMPLETED;

    const completedRun = await this.prisma.attendanceReconciliationRun.update({
      where: { id: run.id },
      data: {
        status: finalStatus,
        totalRecordsProcessed: candidateRecords.length,
        totalReconciled,
        totalQuarantined,
        totalErrors,
        completedAt: new Date(),
        errorDetails: errors.length > 0 ? (errors as any) : undefined,
      },
    });

    return completedRun;
  }

  /**
   * Retrieves paginated reconciliation runs with optional status and date filters.
   */
  async listRuns(
    query: QueryReconciliationRunsDto,
    actorUserId: string,
    actorUserType: string,
  ) {
    const { targetDate, status, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (targetDate) {
      where.targetDate = parseDateOnly(targetDate);
    }
    if (status) {
      where.status = status;
    }

    const [items, total] = await Promise.all([
      this.prisma.attendanceReconciliationRun.findMany({
        where,
        include: {
          triggeredBy: {
            select: { id: true, name: true, email: true, userCode: true },
          },
        },
        orderBy: { startedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.attendanceReconciliationRun.count({ where }),
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
   * Retrieves details of a single reconciliation run including processed records and anomalies.
   */
  async getRunDetails(
    runId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    const run = await this.prisma.attendanceReconciliationRun.findUnique({
      where: { id: runId },
      include: {
        triggeredBy: {
          select: { id: true, name: true, email: true, userCode: true },
        },
        records: {
          select: {
            id: true,
            userId: true,
            attendanceDate: true,
            status: true,
            hasIntegrityAnomaly: true,
            anomalyType: true,
            anomalyDetails: true,
            reconciledAt: true,
            user: {
              select: { id: true, name: true, email: true, userCode: true },
            },
          },
        },
        anomalies: {
          include: {
            resolvedBy: {
              select: { id: true, name: true, email: true, userCode: true },
            },
          },
        },
      },
    });

    if (!run) {
      throw new NotFoundException(
        `Reconciliation run with ID "${runId}" not found.`,
      );
    }

    return run;
  }

  /**
   * Queries reconciliation and anomaly status for a specific user and attendance date.
   */
  async getReconciliationStatus(
    userId: string,
    dateStr: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    await this.accessService.assertSupervisorAccess(
      userId,
      actorUserId,
      actorUserType,
      'attendance.view',
    );

    const attendanceDate = parseDateOnly(dateStr);

    const record = await this.prisma.attendanceRecord.findUnique({
      where: {
        unique_user_daily_attendance: {
          userId,
          attendanceDate,
        },
      },
      include: {
        reconciliationRun: true,
        anomalyResolvedBy: {
          select: { id: true, name: true, email: true, userCode: true },
        },
        anomalies: {
          include: {
            resolvedBy: {
              select: { id: true, name: true, email: true, userCode: true },
            },
          },
        },
      },
    });

    if (!record) {
      return {
        userId,
        date: dateStr,
        isReconciled: false,
        status: null,
        record: null,
      };
    }

    return {
      userId,
      date: dateStr,
      recordId: record.id,
      isReconciled: record.reconciledAt !== null,
      reconciledAt: record.reconciledAt,
      status: record.status,
      hasIntegrityAnomaly: record.hasIntegrityAnomaly,
      anomalyType: record.anomalyType,
      anomalyDetails: record.anomalyDetails,
      anomalyDetectedAt: record.anomalyDetectedAt,
      anomalyResolvedAt: record.anomalyResolvedAt,
      anomalyResolvedBy: record.anomalyResolvedBy,
      reconciliationRunId: record.reconciliationRunId,
      anomalies: record.anomalies,
    };
  }

  /**
   * Lists quarantined attendance anomalies with filters, pagination, and effective data scope enforcement.
   * Utilizes persisted anomaly classifications and lifecycle status.
   */
  async listAnomalies(
    query: QueryAnomaliesDto,
    actorUserId: string,
    actorUserType: string,
  ) {
    const {
      userId,
      departmentId,
      anomalyType,
      isResolved,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = query;
    const skip = (page - 1) * limit;

    if (userId) {
      await this.accessService.assertSupervisorAccess(
        userId,
        actorUserId,
        actorUserType,
        'attendance.view_anomalies',
      );
    }

    const userScopeWhere = await this.usersService.buildDataScopeWhere(
      actorUserId,
      actorUserType,
      'attendance.view_anomalies',
    );

    const where: any = {
      user: userScopeWhere,
    };

    if (userId) where.userId = userId;

    if (departmentId) {
      where.user = {
        ...where.user,
        departments: {
          some: { departmentId },
        },
      };
    }

    if (anomalyType) {
      where.OR = [
        { anomalyType },
        { anomalies: { some: { anomalyType } } },
      ];
    }

    if (isResolved === true) {
      where.hasIntegrityAnomaly = false;
      where.anomalyResolvedAt = { not: null };
    } else if (isResolved === false) {
      where.hasIntegrityAnomaly = true;
    } else {
      // By default show all active anomalies or past anomalies
      where.OR = [
        ...(where.OR || []),
        { hasIntegrityAnomaly: true },
        { anomalyResolvedAt: { not: null } },
      ];
    }

    if (startDate || endDate) {
      where.attendanceDate = {};
      if (startDate) where.attendanceDate.gte = parseDateOnly(startDate);
      if (endDate) where.attendanceDate.lte = parseDateOnly(endDate);
    }

    const [items, total] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              userCode: true,
              departments: {
                include: { department: { select: { id: true, name: true } } },
              },
            },
          },
          shiftDefinition: {
            select: { id: true, code: true, name: true },
          },
          anomalyResolvedBy: {
            select: { id: true, name: true, email: true, userCode: true },
          },
          reconciliationRun: {
            select: { id: true, startedAt: true, status: true },
          },
          anomalies: {
            include: {
              resolvedBy: {
                select: { id: true, name: true, email: true, userCode: true },
              },
            },
          },
        },
        orderBy: { attendanceDate: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.attendanceRecord.count({ where }),
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
   * Retrieves single anomaly details for an attendance record including persistent anomaly rows.
   */
  async getAnomalyDetails(
    recordId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    const record = await this.prisma.attendanceRecord.findUnique({
      where: { id: recordId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            userCode: true,
            departments: {
              include: { department: { select: { id: true, name: true } } },
            },
          },
        },
        shiftDefinition: true,
        sessions: { orderBy: { rawCheckInAt: 'asc' } },
        breaks: { orderBy: { startedAt: 'asc' } },
        anomalyResolvedBy: {
          select: { id: true, name: true, email: true, userCode: true },
        },
        reconciliationRun: true,
        corrections: { orderBy: { createdAt: 'desc' }, take: 5 },
        anomalies: {
          include: {
            resolvedBy: {
              select: { id: true, name: true, email: true, userCode: true },
            },
          },
          orderBy: { detectedAt: 'desc' },
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
      'attendance.view_anomalies',
    );

    return record;
  }

  /**
   * Resolves or dismisses a quarantined attendance anomaly with mandatory reason,
   * Anti-Self-Resolution invariant, and audit history.
   * Preserves persistent anomaly classifications and historical traceability in attendance_anomalies.
   */
  async resolveAnomaly(
    recordId: string,
    dto: ResolveAnomalyDto,
    actorUserId: string,
    actorUserType: string,
  ) {
    const record = await this.prisma.attendanceRecord.findUnique({
      where: { id: recordId },
    });

    if (!record) {
      throw new NotFoundException(
        `Attendance record with ID "${recordId}" not found.`,
      );
    }

    // 1. Anti-Self-Resolution Invariant: Managers cannot resolve their own attendance anomalies
    this.accessService.assertNotSelfAction(
      record.userId,
      actorUserId,
      'resolve your own attendance anomaly',
    );

    // 2. Data Scope Check
    await this.accessService.assertSupervisorAccess(
      record.userId,
      actorUserId,
      actorUserType,
      'attendance.resolve_incident',
    );

    // 3. Ensure record currently has an active, unresolved anomaly
    if (!record.hasIntegrityAnomaly || record.anomalyResolvedAt !== null) {
      throw new BadRequestException(
        'This attendance record does not have an active integrity anomaly.',
      );
    }

    return withDeadlockRetry(async () => {
      return this.prisma.$transaction(async (tx) => {
        // Level 3 Lock: AttendanceRecord
        await tx.$queryRaw`
          SELECT id FROM attendance_records WHERE id = ${recordId} FOR UPDATE
        `;

        const lockedRecord = await tx.attendanceRecord.findUniqueOrThrow({
          where: { id: recordId },
        });

        if (!lockedRecord.hasIntegrityAnomaly || lockedRecord.anomalyResolvedAt !== null) {
          throw new BadRequestException(
            'This attendance record does not have an active integrity anomaly.',
          );
        }

        const now = new Date();
        const targetAnomalyStatus =
          dto.action === AnomalyResolutionAction.RESOLVE
            ? AnomalyStatus.RESOLVED
            : AnomalyStatus.DISMISSED;

        // Update all active persisted anomaly items while preserving their anomalyType classification
        await tx.attendanceAnomaly.updateMany({
          where: {
            attendanceRecordId: recordId,
            status: AnomalyStatus.ACTIVE,
          },
          data: {
            status: targetAnomalyStatus,
            resolvedAt: now,
            resolvedByUserId: actorUserId,
            resolutionNotes: dto.notes,
          },
        });

        if (dto.action === AnomalyResolutionAction.RESOLVE) {
          // If resolving, clear anomaly flags and run authoritative recalculation if requested
          await tx.attendanceRecord.update({
            where: { id: recordId },
            data: {
              hasIntegrityAnomaly: false,
              anomalyResolvedAt: now,
              anomalyResolvedByUserId: actorUserId,
              anomalyResolutionNotes: dto.notes,
              version: { increment: 1 },
            },
          });

          if (dto.recalculate !== false) {
            // Trigger recalculation under current locked transaction
            await this.calculationService.recalculateAndPersist(
              recordId,
              {
                isReconciled: true,
                actorUserId,
                skipLocking: true,
              },
              tx,
            );
          }
        } else {
          // DISMISS action: mark anomaly cleared with note, leave as ABSENT
          await tx.attendanceRecord.update({
            where: { id: recordId },
            data: {
              hasIntegrityAnomaly: false,
              anomalyResolvedAt: now,
              anomalyResolvedByUserId: actorUserId,
              anomalyResolutionNotes: dto.notes,
              status: AttendanceStatus.ABSENT,
              version: { increment: 1 },
            },
          });
        }

        const updatedRecord = await tx.attendanceRecord.findUniqueOrThrow({
          where: { id: recordId },
          include: {
            anomalyResolvedBy: {
              select: { id: true, name: true, email: true, userCode: true },
            },
            anomalies: {
              include: {
                resolvedBy: {
                  select: { id: true, name: true, email: true, userCode: true },
                },
              },
              orderBy: { detectedAt: 'desc' },
            },
          },
        });

        await this.auditService.logAudit({
          actorUserId,
          action: AuditAction.STATUS_CHANGE,
          module: 'ATTENDANCE',
          entityType: 'AttendanceRecord',
          entityId: recordId,
          oldValues: {
            status: record.status,
            hasIntegrityAnomaly: record.hasIntegrityAnomaly,
            anomalyType: record.anomalyType,
          },
          newValues: {
            status: updatedRecord.status,
            hasIntegrityAnomaly: false,
            action: dto.action,
            notes: dto.notes,
            resolvedAnomaliesCount: updatedRecord.anomalies.length,
          },
        });

        return updatedRecord;
      });
    });
  }
}
