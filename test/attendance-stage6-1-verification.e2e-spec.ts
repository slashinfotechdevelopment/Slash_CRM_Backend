import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import {
  AttendanceStatus,
  AttendanceSessionStatus,
  AttendanceCorrectionStatus,
  VerificationOutcome,
  OvertimeApprovalStatus,
} from '../src/generated/prisma/enums';

describe('Stage 6.1: Attendance Database Architecture Verification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let testUserId: string;
  let shiftDefId: string;
  let attendanceRecordId: string;
  const testDate = new Date('2026-11-04T00:00:00.000Z');

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get<PrismaService>(PrismaService);

    // Find an active employee
    const user = await prisma.user.findFirst({
      where: { status: 'ACTIVE', deletedAt: null },
    });
    if (!user) {
      throw new Error('No active user found in database for testing.');
    }
    testUserId = user.id;

    // Ensure a standard shift definition exists
    let shiftDef = await prisma.shiftDefinition.findUnique({
      where: { code: 'STD_09_18_TEST' },
    });
    if (!shiftDef) {
      shiftDef = await prisma.shiftDefinition.create({
        data: {
          code: 'STD_09_18_TEST',
          name: 'Standard General Shift Test',
          startTime: '09:00',
          endTime: '18:00',
          breakPolicySnapshot: JSON.stringify({
            paidAllowanceMinutes: 60,
            breakTypes: [{ code: 'LUNCH', maxDurationMinutes: 60 }],
          }),
        },
      });
    }
    shiftDefId = shiftDef.id;

    // Ensure daily attendance record exists
    let record = await prisma.attendanceRecord.findUnique({
      where: {
        unique_user_daily_attendance: {
          userId: testUserId,
          attendanceDate: testDate,
        },
      },
    });
    if (!record) {
      record = await prisma.attendanceRecord.create({
        data: {
          userId: testUserId,
          shiftDefinitionId: shiftDefId,
          attendanceDate: testDate,
          shiftStartTimeSnapshot: new Date('2026-11-04T03:30:00.000Z'), // 09:00 IST
          shiftEndTimeSnapshot: new Date('2026-11-04T12:30:00.000Z'),   // 18:00 IST
          halfDayThresholdSecondsSnapshot: 14400,
          fullDayThresholdSecondsSnapshot: 28800,
          overtimeThresholdSecondsSnapshot: 32400,
          breakPolicySnapshot: shiftDef.breakPolicySnapshot,
        },
      });
    }
    attendanceRecordId = record.id;
  });

  afterAll(async () => {
    // Clean up test data
    if (attendanceRecordId) {
      await prisma.attendanceEvidenceVerification.deleteMany({
        where: { correctionRequest: { attendanceRecordId } },
      });
      await prisma.attendanceCorrectionRequest.deleteMany({
        where: { attendanceRecordId },
      });
      await prisma.attendanceBreak.deleteMany({
        where: { attendanceRecordId },
      });
      await prisma.attendanceSession.deleteMany({
        where: { attendanceRecordId },
      });
    }
    await app.close();
  });

  describe('1. MySQL Schema & Virtual Generated Columns Verification', () => {
    it('should detect all 9 attendance tables in information_schema', async () => {
      const tables: any[] = await prisma.$queryRawUnsafe(`
        SELECT TABLE_NAME 
        FROM information_schema.TABLES 
        WHERE TABLE_SCHEMA = 'slash_infotech_crm' 
          AND (TABLE_NAME LIKE 'attendance%' OR TABLE_NAME LIKE 'shift%' OR TABLE_NAME LIKE 'employee_shift%')
        ORDER BY TABLE_NAME;
      `);
      const tableNames = tables.map((t) => t.TABLE_NAME);
      expect(tableNames).toContain('shift_definitions');
      expect(tableNames).toContain('employee_shift_assignments');
      expect(tableNames).toContain('attendance_records');
      expect(tableNames).toContain('attendance_sessions');
      expect(tableNames).toContain('attendance_breaks');
      expect(tableNames).toContain('attendance_correction_requests');
      expect(tableNames).toContain('attendance_evidence_verifications');
      expect(tableNames).toContain('attendance_overtime_requests');
      expect(tableNames).toContain('attendance_wfh_requests');
    });

    it('should confirm active_session_user_id and active_break_user_id are VIRTUAL generated columns in MySQL', async () => {
      const virtualCols: any[] = await prisma.$queryRawUnsafe(`
        SELECT TABLE_NAME, COLUMN_NAME, GENERATION_EXPRESSION, EXTRA 
        FROM information_schema.COLUMNS 
        WHERE TABLE_SCHEMA = 'slash_infotech_crm' 
          AND EXTRA LIKE '%VIRTUAL%'
        ORDER BY TABLE_NAME, COLUMN_NAME;
      `);

      const sessionCol = virtualCols.find(
        (c) => c.TABLE_NAME === 'attendance_sessions' && c.COLUMN_NAME === 'active_session_user_id',
      );
      const breakCol = virtualCols.find(
        (c) => c.TABLE_NAME === 'attendance_breaks' && c.COLUMN_NAME === 'active_break_user_id',
      );

      expect(sessionCol).toBeDefined();
      expect(sessionCol.EXTRA).toContain('VIRTUAL');
      expect(sessionCol.GENERATION_EXPRESSION).toContain('ACTIVE');

      expect(breakCol).toBeDefined();
      expect(breakCol.EXTRA).toContain('VIRTUAL');
      expect(breakCol.GENERATION_EXPRESSION).toContain('ended_at');
    });

    it('should confirm active unique indexes exist in MySQL statistics', async () => {
      const uniqueIdxs: any[] = await prisma.$queryRawUnsafe(`
        SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE 
        FROM information_schema.STATISTICS 
        WHERE TABLE_SCHEMA = 'slash_infotech_crm' 
          AND INDEX_NAME IN ('unique_active_session_per_user', 'unique_active_break_per_user')
        ORDER BY TABLE_NAME, INDEX_NAME;
      `);

      const sessionIdx = uniqueIdxs.find(
        (i) => i.INDEX_NAME === 'unique_active_session_per_user',
      );
      const breakIdx = uniqueIdxs.find(
        (i) => i.INDEX_NAME === 'unique_active_break_per_user',
      );

      expect(sessionIdx).toBeDefined();
      expect(sessionIdx.NON_UNIQUE).toBe(0); // 0 means UNIQUE index

      expect(breakIdx).toBeDefined();
      expect(breakIdx.NON_UNIQUE).toBe(0); // 0 means UNIQUE index
    });
  });

  describe('2. Active Session Concurrency & Unique-Index Enforcement', () => {
    let activeSessionId: string;

    it('should allow inserting an initial ACTIVE session', async () => {
      const session = await prisma.attendanceSession.create({
        data: {
          attendanceRecordId,
          userId: testUserId,
          rawCheckInAt: new Date(),
          checkInAt: new Date(),
          status: AttendanceSessionStatus.ACTIVE,
        },
      });
      expect(session.id).toBeDefined();
      expect(session.status).toBe(AttendanceSessionStatus.ACTIVE);
      activeSessionId = session.id;
    });

    it('should REJECT a concurrent second ACTIVE session for the same user (Duplicate active_session_user_id)', async () => {
      let threwError = false;
      try {
        await prisma.attendanceSession.create({
          data: {
            attendanceRecordId,
            userId: testUserId,
            rawCheckInAt: new Date(),
            checkInAt: new Date(),
            status: AttendanceSessionStatus.ACTIVE,
          },
        });
      } catch (err: any) {
        threwError = true;
        // Prisma code P2002 represents Unique constraint violation
        expect(err.code).toBe('P2002');
      }
      expect(threwError).toBe(true);
    });

    it('should allow completing the first session (status = COMPLETED) and then inserting a new ACTIVE session', async () => {
      await prisma.attendanceSession.update({
        where: { id: activeSessionId },
        data: {
          checkOutAt: new Date(),
          status: AttendanceSessionStatus.COMPLETED,
          durationSeconds: 3600,
        },
      });

      // Now inserting a second ACTIVE session must succeed because the first has status = COMPLETED (virtual column = NULL)
      const secondSession = await prisma.attendanceSession.create({
        data: {
          attendanceRecordId,
          userId: testUserId,
          rawCheckInAt: new Date(),
          checkInAt: new Date(),
          status: AttendanceSessionStatus.ACTIVE,
        },
      });
      expect(secondSession.id).toBeDefined();

      // Clean up second session
      await prisma.attendanceSession.delete({ where: { id: secondSession.id } });
    });
  });

  describe('3. Active Break Concurrency & Unique-Index Enforcement', () => {
    let activeBreakId: string;

    it('should allow inserting an initial ACTIVE break (endedAt = null)', async () => {
      const brk = await prisma.attendanceBreak.create({
        data: {
          attendanceRecordId,
          userId: testUserId,
          breakTypeId: 'LUNCH',
          startedAt: new Date(),
          endedAt: null,
        },
      });
      expect(brk.id).toBeDefined();
      activeBreakId = brk.id;
    });

    it('should REJECT a concurrent second active break for the same user (endedAt = null)', async () => {
      let threwError = false;
      try {
        await prisma.attendanceBreak.create({
          data: {
            attendanceRecordId,
            userId: testUserId,
            breakTypeId: 'TEA',
            startedAt: new Date(),
            endedAt: null,
          },
        });
      } catch (err: any) {
        threwError = true;
        expect(err.code).toBe('P2002');
      }
      expect(threwError).toBe(true);
    });

    it('should allow ending the break (endedAt set) and then inserting a new active break', async () => {
      await prisma.attendanceBreak.update({
        where: { id: activeBreakId },
        data: {
          endedAt: new Date(),
          paidDurationSeconds: 900,
        },
      });

      const secondBreak = await prisma.attendanceBreak.create({
        data: {
          attendanceRecordId,
          userId: testUserId,
          breakTypeId: 'TEA',
          startedAt: new Date(),
          endedAt: null,
        },
      });
      expect(secondBreak.id).toBeDefined();

      // Clean up second break
      await prisma.attendanceBreak.delete({ where: { id: secondBreak.id } });
    });
  });

  describe('4. Concurrent Service-Level Check-in Test', () => {
    it('should handle simultaneous check-in attempts so exactly one succeeds and one is rejected', async () => {
      // Clean up any remaining sessions
      await prisma.attendanceSession.deleteMany({ where: { attendanceRecordId } });

      const results = await Promise.allSettled([
        prisma.attendanceSession.create({
          data: {
            attendanceRecordId,
            userId: testUserId,
            rawCheckInAt: new Date(),
            checkInAt: new Date(),
            status: AttendanceSessionStatus.ACTIVE,
          },
        }),
        prisma.attendanceSession.create({
          data: {
            attendanceRecordId,
            userId: testUserId,
            rawCheckInAt: new Date(),
            checkInAt: new Date(),
            status: AttendanceSessionStatus.ACTIVE,
          },
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
    });
  });

  describe('5. Composite Ownership & Evidence Verification', () => {
    it('should create and verify AttendanceEvidenceVerification entity linked to AttendanceCorrectionRequest', async () => {
      // Find completed session
      const session = await prisma.attendanceSession.findFirst({
        where: { attendanceRecordId },
      });
      expect(session).toBeDefined();

      const correction = await prisma.attendanceCorrectionRequest.create({
        data: {
          attendanceRecordId,
          userId: testUserId,
          attendanceSessionId: session!.id,
          requestedCheckInAt: new Date('2026-11-04T03:30:00.000Z'),
          requestedCheckOutAt: new Date('2026-11-04T12:45:00.000Z'),
          reason: 'Emergency server outage resolution after hours',
          status: AttendanceCorrectionStatus.PENDING,
        },
      });
      expect(correction.id).toBeDefined();

      const verification = await prisma.attendanceEvidenceVerification.create({
        data: {
          correctionRequestId: correction.id,
          reviewerUserId: testUserId,
          evidenceReference: 'https://github.com/slashinfotech/crm/pull/402',
          outcome: VerificationOutcome.VERIFIED,
          verificationNotes: 'Verified PR merge timestamp at 18:15 IST and Git commit logs.',
        },
      });
      expect(verification.id).toBeDefined();
      expect(verification.outcome).toBe(VerificationOutcome.VERIFIED);
    });
  });

  describe('6. Mathematical Overtime & Interval Intersection Formulation', () => {
    // Helper implementing the exact approved mathematical interval intersection
    function calculateOvertime({
      workIntervals,
      authorizedIntervals,
      unpaidBreakSegments,
      shiftEnd,
      dailyThresholdSeconds,
    }: {
      workIntervals: [number, number][];
      authorizedIntervals: [number, number][];
      unpaidBreakSegments: [number, number][];
      shiftEnd: number;
      dailyThresholdSeconds: number;
    }) {
      // 1. Post-shift work intervals
      const postShiftWork: [number, number][] = [];
      for (const [start, end] of workIntervals) {
        const pStart = Math.max(start, shiftEnd);
        const pEnd = Math.max(end, shiftEnd);
        if (pEnd > pStart) {
          postShiftWork.push([pStart, pEnd]);
        }
      }

      // 2. Union of authorized intervals
      const sortedAuth = [...authorizedIntervals].sort((a, b) => a[0] - b[0]);
      const mergedAuth: [number, number][] = [];
      for (const cur of sortedAuth) {
        if (mergedAuth.length === 0) {
          mergedAuth.push([...cur]);
        } else {
          const prev = mergedAuth[mergedAuth.length - 1];
          if (cur[0] <= prev[1]) {
            prev[1] = Math.max(prev[1], cur[1]);
          } else {
            mergedAuth.push([...cur]);
          }
        }
      }

      // 3. Intersect post-shift work with merged authorized intervals
      const authorizedWork: [number, number][] = [];
      for (const [wStart, wEnd] of postShiftWork) {
        for (const [aStart, aEnd] of mergedAuth) {
          const iStart = Math.max(wStart, aStart);
          const iEnd = Math.min(wEnd, aEnd);
          if (iEnd > iStart) {
            authorizedWork.push([iStart, iEnd]);
          }
        }
      }

      // 4. Subtract unpaid break segments from authorized work
      let eligibleSeconds = 0;
      for (const [awStart, awEnd] of authorizedWork) {
        let segDuration = awEnd - awStart;
        for (const [ubStart, ubEnd] of unpaidBreakSegments) {
          const oStart = Math.max(awStart, ubStart);
          const oEnd = Math.min(awEnd, ubEnd);
          if (oEnd > oStart) {
            segDuration -= (oEnd - oStart);
          }
        }
        eligibleSeconds += Math.max(0, segDuration);
      }

      // 5. Total daily net work
      let totalGross = 0;
      for (const [start, end] of workIntervals) {
        totalGross += (end - start);
      }
      let totalUnpaid = 0;
      for (const [ubStart, ubEnd] of unpaidBreakSegments) {
        totalUnpaid += (ubEnd - ubStart);
      }
      const totalDailyNet = Math.max(0, totalGross - totalUnpaid);
      const dailyExcess = Math.max(0, totalDailyNet - dailyThresholdSeconds);

      // 6. Credited overtime
      return Math.min(eligibleSeconds, dailyExcess);
    }

    it('Example 1: Work entirely inside authorization should credit full authorized post-shift work', () => {
      // Shift end: 18:00 (1080m). Auth: [18:00, 20:00] (1080m to 1200m).
      // Work: 09:00 to 19:30 (540m to 1170m = 630m). Paid break: 60m. Daily threshold: 8h (480m).
      const credited = calculateOvertime({
        workIntervals: [[540, 1170]],
        authorizedIntervals: [[1080, 1200]],
        unpaidBreakSegments: [],
        shiftEnd: 1080,
        dailyThresholdSeconds: 480,
      });
      // Post-shift: [1080, 1170] = 90m (1h 30m). Inside auth: 90m. Total net: 630m. Excess: 630 - 480 = 150m.
      expect(credited).toBe(90);
    });

    it('Example 2: Work entirely outside authorization should credit 0 overtime', () => {
      // Shift end: 18:00 (1080m). Auth: [18:00, 19:00] (1080m to 1140m).
      // Work: [20:00, 21:30] (1200m to 1290m). Post-shift work falls outside auth!
      const credited = calculateOvertime({
        workIntervals: [[540, 1080], [1200, 1290]],
        authorizedIntervals: [[1080, 1140]],
        unpaidBreakSegments: [],
        shiftEnd: 1080,
        dailyThresholdSeconds: 480,
      });
      expect(credited).toBe(0);
    });

    it('Example 3: Work partly inside authorization should only credit the overlapping portion', () => {
      // Auth: [18:00, 19:30] (1080m to 1170m = 90m). Work: [09:00, 20:30] (540m to 1230m).
      // Post-shift work: [1080, 1230] = 150m. Overlap with auth: [1080, 1170] = 90m.
      const credited = calculateOvertime({
        workIntervals: [[540, 1230]],
        authorizedIntervals: [[1080, 1170]],
        unpaidBreakSegments: [],
        shiftEnd: 1080,
        dailyThresholdSeconds: 480,
      });
      expect(credited).toBe(90);
    });

    it('Example 4: Overlapping authorization requests should be unioned and not inflate authorization', () => {
      // Request 1: [18:00, 19:30] (90m). Request 2: [19:00, 20:30] (90m). Union = [18:00, 20:30] = 150m.
      // Work: [09:00, 21:00] (540m to 1260m). Overlap with union: 150m.
      const credited = calculateOvertime({
        workIntervals: [[540, 1260]],
        authorizedIntervals: [[1080, 1170], [1140, 1230]],
        unpaidBreakSegments: [],
        shiftEnd: 1080,
        dailyThresholdSeconds: 480,
      });
      expect(credited).toBe(150); // 150m, not 180m!
    });

    it('Example 6: An authorized interval containing an unpaid break should deduct the break', () => {
      // Auth: [18:00, 20:00] (1080m to 1200m = 120m). Work: [09:00, 20:00] (540m to 1200m).
      // Unpaid break: [18:30, 19:30] (1110m to 1170m = 60m).
      // Eligible post-shift work = 120m - 60m = 60m.
      const credited = calculateOvertime({
        workIntervals: [[540, 1200]],
        authorizedIntervals: [[1080, 1200]],
        unpaidBreakSegments: [[1110, 1170]],
        shiftEnd: 1080,
        dailyThresholdSeconds: 480,
      });
      expect(credited).toBe(60);
    });
  });
});

