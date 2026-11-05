import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import {
  AttendanceSessionStatus,
  AttendanceStatus,
  OvertimeApprovalStatus,
  RecordStatus,
} from '../src/generated/prisma/enums';
import {
  formatDateOnly,
  getAsiaKolkataDateString,
  parseDateOnly,
} from '../src/modules/attendance/attendance.utils';
import { AttendanceCalculationService } from '../src/modules/attendance/attendance-calculation.service';

describe('Phase 6.2.4: Deterministic Attendance Interval Calculation Engine (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let calcService: AttendanceCalculationService;

  let superAdminToken: string;
  let superAdminId: string;

  let employeeToken: string;
  let employeeId: string;

  let managerToken: string;
  let managerId: string;

  let testShiftId: string;
  const createdRecordIds: string[] = [];
  const createdOvertimeIds: string[] = [];
  let createdPmUserId: string | null = null;

  const defaultBreakPolicy = {
    paidAllowanceMinutes: 60,
    breakTypes: [
      { code: 'TEA', name: 'Tea Break', maxDurationMinutes: 15, isPaid: true },
      { code: 'LUNCH', name: 'Lunch Break', maxDurationMinutes: 45, isPaid: true },
      { code: 'UNPAID_EXTRA', name: 'Extra Break', maxDurationMinutes: 60, isPaid: false },
    ],
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    app.useGlobalInterceptors(new TransformInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());

    await app.init();
    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    calcService = app.get(AttendanceCalculationService);

    // 1. Super Admin
    const superAdmin = await prisma.user.findFirst({
      where: {
        userType: { code: 'SUPER_ADMIN' },
        deletedAt: null,
      },
    });
    if (!superAdmin) throw new Error('Super Admin not found');
    superAdminId = superAdmin.id;

    const saSession = await prisma.userSession.create({
      data: {
        userId: superAdmin.id,
        refreshTokenHash: 'e2e_sa_624_' + Date.now(),
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    superAdminToken = await jwtService.signAsync(
      {
        sub: superAdmin.id,
        email: superAdmin.email,
        userCode: superAdmin.userCode,
        userType: 'SUPER_ADMIN',
        roles: ['SUPER_ADMIN'],
        sessionId: saSession.id,
      },
      { secret: 'slash@202612354', expiresIn: '15m' },
    );

    // 2. Main Test Employee (DEVELOPER role, OWN scope)
    const emp = await prisma.user.findFirst({
      where: {
        userType: { code: 'EMPLOYEE' },
        userRoles: { some: { role: { code: 'DEVELOPER' } } },
        deletedAt: null,
        status: RecordStatus.ACTIVE,
      },
      include: { employeeProfile: true },
    });
    if (!emp || !emp.employeeProfile) throw new Error('Employee not found');
    employeeId = emp.id;

    const empSession = await prisma.userSession.create({
      data: {
        userId: emp.id,
        refreshTokenHash: 'e2e_emp_624_' + Date.now(),
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    employeeToken = await jwtService.signAsync(
      {
        sub: emp.id,
        email: emp.email,
        userCode: emp.userCode,
        userType: 'EMPLOYEE',
        roles: ['DEVELOPER'],
        sessionId: empSession.id,
      },
      { secret: 'slash@202612354', expiresIn: '15m' },
    );

    // 3. Project Manager (has attendance.manage_shifts, DEPARTMENT scope, but lacks attendance.resolve_incident)
    let pm = await prisma.user.findFirst({
      where: {
        userType: { code: 'EMPLOYEE' },
        userRoles: { some: { role: { code: 'PROJECT_MANAGER' } } },
        deletedAt: null,
      },
    });
    if (!pm) {
      const empType = await prisma.userType.findUniqueOrThrow({ where: { code: 'EMPLOYEE' } });
      const pmRole = await prisma.role.findUniqueOrThrow({ where: { code: 'PROJECT_MANAGER' } });
      pm = await prisma.user.create({
        data: {
          userCode: 'PM_TEST_624',
          name: 'QA Test Project Manager',
          email: 'qa.pm.624@slashcrm.com',
          userTypeId: empType.id,
          userRoles: { create: { roleId: pmRole.id } },
        },
      });
      createdPmUserId = pm.id;
    }
    managerId = pm.id;

    // Ensure emp and PM share a department for DEPARTMENT data scope access
    const dept = await prisma.department.findFirst();
    if (dept) {
      await prisma.userDepartment.upsert({
        where: { userId_departmentId: { userId: emp.id, departmentId: dept.id } },
        create: { userId: emp.id, departmentId: dept.id, isPrimary: true },
        update: {},
      });
      await prisma.userDepartment.upsert({
        where: { userId_departmentId: { userId: pm.id, departmentId: dept.id } },
        create: { userId: pm.id, departmentId: dept.id, isPrimary: true },
        update: {},
      });
    }

    const pmSession = await prisma.userSession.create({
      data: {
        userId: pm.id,
        refreshTokenHash: 'e2e_pm_624_' + Date.now(),
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    managerToken = await jwtService.signAsync(
      {
        sub: pm.id,
        email: pm.email,
        userCode: pm.userCode,
        userType: 'EMPLOYEE',
        roles: ['PROJECT_MANAGER'],
        sessionId: pmSession.id,
      },
      { secret: 'slash@202612354', expiresIn: '15m' },
    );

    // 4. Test Shift Definition (9:00 to 18:00, 1h paid break allowance, 4h half-day, 8h full-day)
    let shift = await prisma.shiftDefinition.findUnique({
      where: { code: 'TEST_CALC_SHIFT_624' },
    });
    if (!shift) {
      shift = await prisma.shiftDefinition.create({
        data: {
          code: 'TEST_CALC_SHIFT_624',
          name: 'Deterministic Calculation Test Shift',
          startTime: '09:00',
          endTime: '18:00',
          isOvernight: false,
          gracePeriodMinutes: 15,
          halfDayThresholdMinutes: 240, // 4 hours = 14400s
          fullDayThresholdMinutes: 480, // 8 hours = 28800s
          overtimeThresholdMinutes: 540, // 9 hours = 32400s
          allowMultipleSessions: true,
          autoCloseGraceMinutes: 30,
          breakPolicySnapshot: JSON.stringify(defaultBreakPolicy),
        },
      });
    }
    testShiftId = shift.id;
  });

  afterAll(async () => {
    // Clean up created records and test entities
    if (createdOvertimeIds.length > 0) {
      await prisma.attendanceOvertimeRequest.deleteMany({
        where: { id: { in: createdOvertimeIds } },
      });
    }
    if (testShiftId) {
      await prisma.attendanceBreak.deleteMany({
        where: { attendanceRecord: { shiftDefinitionId: testShiftId } },
      });
      await prisma.attendanceSession.deleteMany({
        where: { attendanceRecord: { shiftDefinitionId: testShiftId } },
      });
      await prisma.attendanceRecord.deleteMany({
        where: { shiftDefinitionId: testShiftId },
      });
      await prisma.employeeShiftAssignment.deleteMany({
        where: { shiftDefinitionId: testShiftId },
      });
      await prisma.shiftDefinition.deleteMany({
        where: { code: 'TEST_CALC_SHIFT_624' },
      });
    }
    if (createdRecordIds.length > 0) {
      await prisma.attendanceBreak.deleteMany({
        where: { attendanceRecordId: { in: createdRecordIds } },
      });
      await prisma.attendanceSession.deleteMany({
        where: { attendanceRecordId: { in: createdRecordIds } },
      });
      await prisma.attendanceRecord.deleteMany({
        where: { id: { in: createdRecordIds } },
      });
    }
    if (createdPmUserId) {
      await prisma.userSession.deleteMany({ where: { userId: createdPmUserId } });
      await prisma.userDepartment.deleteMany({ where: { userId: createdPmUserId } });
      await prisma.userRole.deleteMany({ where: { userId: createdPmUserId } });
      await prisma.user.delete({ where: { id: createdPmUserId } });
    }
    await app.close();
  });

  // Helper to create an isolated AttendanceRecord with historical snapshots
  async function createTestRecord(options: {
    dateStr: string;
    shiftStartTime?: string; // e.g. "09:00:00"
    shiftEndTime?: string; // e.g. "18:00:00"
    halfDaySeconds?: number;
    fullDaySeconds?: number;
    paidAllowanceMinutes?: number;
    allowMultipleSessions?: boolean;
    userId?: string;
  }) {
    const {
      dateStr,
      shiftStartTime = '09:00:00',
      shiftEndTime = '18:00:00',
      halfDaySeconds = 14400,
      fullDaySeconds = 28800,
      paidAllowanceMinutes = 60,
      allowMultipleSessions = true,
      userId = employeeId,
    } = options;

    const attendanceDate = parseDateOnly(dateStr);

    // Clean up any pre-existing record on this date
    const existing = await prisma.attendanceRecord.findUnique({
      where: {
        unique_user_daily_attendance: {
          userId,
          attendanceDate,
        },
      },
    });
    if (existing) {
      await prisma.attendanceBreak.deleteMany({ where: { attendanceRecordId: existing.id } });
      await prisma.attendanceSession.deleteMany({ where: { attendanceRecordId: existing.id } });
      await prisma.attendanceRecord.delete({ where: { id: existing.id } });
    }

    const policy = {
      paidAllowanceMinutes,
      breakTypes: defaultBreakPolicy.breakTypes,
    };

    const record = await prisma.attendanceRecord.create({
      data: {
        userId,
        shiftDefinitionId: testShiftId,
        attendanceDate,
        status: AttendanceStatus.PENDING_RECONCILIATION,
        shiftStartTimeSnapshot: new Date(`${dateStr}T${shiftStartTime}.000Z`),
        shiftEndTimeSnapshot: new Date(`${dateStr}T${shiftEndTime}.000Z`),
        isOvernightSnapshot: false,
        halfDayThresholdSecondsSnapshot: halfDaySeconds,
        fullDayThresholdSecondsSnapshot: fullDaySeconds,
        overtimeThresholdSecondsSnapshot: 32400,
        allowMultipleSessionsSnapshot: allowMultipleSessions,
        breakPolicySnapshot: JSON.stringify(policy),
      },
    });

    createdRecordIds.push(record.id);
    return record;
  }

  // Helper to create an AttendanceSession
  async function createSession(options: {
    recordId: string;
    checkIn: string; // ISO string
    checkOut?: string | null; // ISO string or null
    status?: AttendanceSessionStatus;
    userId?: string;
  }) {
    const { recordId, checkIn, checkOut = null, status, userId = employeeId } = options;
    const inDate = new Date(checkIn);
    const outDate = checkOut ? new Date(checkOut) : null;
    const dur = outDate ? Math.floor((outDate.getTime() - inDate.getTime()) / 1000) : null;

    return prisma.attendanceSession.create({
      data: {
        attendanceRecordId: recordId,
        userId,
        rawCheckInAt: inDate,
        rawCheckOutAt: outDate,
        checkInAt: inDate,
        checkOutAt: outDate,
        durationSeconds: dur,
        status: status ?? (outDate ? AttendanceSessionStatus.COMPLETED : AttendanceSessionStatus.ACTIVE),
      },
    });
  }

  // Helper to create an AttendanceBreak
  async function createBreak(options: {
    recordId: string;
    start: string; // ISO string
    end?: string | null; // ISO string or null
    breakType?: string;
    userId?: string;
  }) {
    const { recordId, start, end = null, breakType = 'TEA', userId = employeeId } = options;
    return prisma.attendanceBreak.create({
      data: {
        attendanceRecordId: recordId,
        userId,
        breakTypeId: breakType,
        startedAt: new Date(start),
        endedAt: end ? new Date(end) : null,
        paidDurationSeconds: 0,
        unpaidDurationSeconds: 0,
      },
    });
  }

  // Helper to create an AttendanceOvertimeRequest
  async function createOvertime(options: {
    dateStr: string;
    start: string;
    end: string;
    status?: OvertimeApprovalStatus;
    userId?: string;
  }) {
    const { dateStr, start, end, status = OvertimeApprovalStatus.APPROVED, userId = employeeId } = options;
    const inDate = new Date(start);
    const outDate = new Date(end);
    const minutes = Math.floor((outDate.getTime() - inDate.getTime()) / 60000);

    const ot = await prisma.attendanceOvertimeRequest.create({
      data: {
        userId,
        attendanceDate: parseDateOnly(dateStr),
        startTime: inDate,
        endTime: outDate,
        approvedDurationMinutes: minutes,
        reason: 'Phase 6.2.4 overtime test',
        status,
        reviewedByUserId: superAdminId,
        reviewedAt: new Date(),
      },
    });

    createdOvertimeIds.push(ot.id);
    return ot;
  }

  // =========================================================================
  // SUITE 1: Working Sessions & Aggregation Engine (Scenarios 1-4)
  // =========================================================================
  describe('1. Working Sessions & Aggregation Engine', () => {
    it('1.1 should accurately calculate duration for a single completed session (28,800s = 8 hours)', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-01' });
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-01T09:00:00.000Z',
        checkOut: '2026-04-01T17:00:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.result.grossWorkingDurationSeconds).toBe(28800);
      expect(res.body.data.result.netWorkingDurationSeconds).toBe(28800);
      expect(res.body.data.result.hasIntegrityAnomaly).toBe(false);

      const dbRecord = await prisma.attendanceRecord.findUnique({ where: { id: record.id } });
      expect(dbRecord?.grossWorkingDurationSeconds).toBe(28800);
    });

    it('1.2 should aggregate multiple disjoint completed sessions correctly across the day (14,400s + 14,400s = 28,800s)', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-02' });
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-02T09:00:00.000Z',
        checkOut: '2026-04-02T13:00:00.000Z', // 4h = 14400s
      });
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-02T14:00:00.000Z',
        checkOut: '2026-04-02T18:00:00.000Z', // 4h = 14400s
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.grossWorkingDurationSeconds).toBe(28800);
      expect(res.body.data.result.netWorkingDurationSeconds).toBe(28800);
      expect(res.body.data.result.hasIntegrityAnomaly).toBe(false);
    });

    it('1.3 should detect overlapping sessions, flag integrity anomaly, and take geometric union without double counting', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-03' });
      // Session 1: 09:00 to 13:00 (4 hours)
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-03T09:00:00.000Z',
        checkOut: '2026-04-03T13:00:00.000Z',
      });
      // Session 2: 12:00 to 15:00 (3 hours, overlapping by 1 hour)
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-03T12:00:00.000Z',
        checkOut: '2026-04-03T15:00:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      // Union of [09:00, 13:00] and [12:00, 15:00] is [09:00, 15:00] = 6 hours = 21,600s (NOT 7 hours)
      expect(res.body.data.result.grossWorkingDurationSeconds).toBe(21600);
      expect(res.body.data.result.hasIntegrityAnomaly).toBe(true);
      expect(res.body.data.result.anomalyType).toBe('OVERLAPPING_SESSIONS');
      expect(res.body.data.result.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);

      const dbRecord = await prisma.attendanceRecord.findUnique({ where: { id: record.id } });
      expect(dbRecord?.hasIntegrityAnomaly).toBe(true);
      expect(dbRecord?.anomalyType).toBe('OVERLAPPING_SESSIONS');
    });

    it('1.4 should handle incomplete active sessions by not counting them as completed and holding status in PENDING_RECONCILIATION', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-04' });
      // Completed session: 09:00 to 12:00 (3 hours = 10,800s)
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-04T09:00:00.000Z',
        checkOut: '2026-04-04T12:00:00.000Z',
      });
      // Active session: 13:00 to null
      const activeSession = await createSession({
        recordId: record.id,
        checkIn: '2026-04-04T13:00:00.000Z',
        checkOut: null,
        status: AttendanceSessionStatus.ACTIVE,
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ isReconciled: true })
        .expect(200);

      // Only the completed session is counted in gross
      expect(res.body.data.result.grossWorkingDurationSeconds).toBe(10800);
      // Status must remain PENDING_RECONCILIATION despite isReconciled: true because an active session is unresolved
      expect(res.body.data.result.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);

      // Clean up active session to release virtual lock
      await prisma.attendanceSession.delete({ where: { id: activeSession.id } });
    });
  });

  // =========================================================================
  // SUITE 2: Break Allocation & Complete Containment Engine (Scenarios 2.1-2.11)
  // =========================================================================
  describe('2. Break Allocation & Complete Containment Engine', () => {
    it('2.1 should allocate paid break allowance chronologically (Break 1: 1800s paid, Break 2: 1200s paid)', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-05', paidAllowanceMinutes: 60 });
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-05T09:00:00.000Z',
        checkOut: '2026-04-05T18:00:00.000Z', // 9h = 32400s
      });
      const b1 = await createBreak({
        recordId: record.id,
        start: '2026-04-05T10:00:00.000Z',
        end: '2026-04-05T10:30:00.000Z', // 30m = 1800s
      });
      const b2 = await createBreak({
        recordId: record.id,
        start: '2026-04-05T13:00:00.000Z',
        end: '2026-04-05T13:20:00.000Z', // 20m = 1200s
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.paidBreakDurationSeconds).toBe(3000);
      expect(res.body.data.result.unpaidBreakDurationSeconds).toBe(0);
      expect(res.body.data.result.netWorkingDurationSeconds).toBe(32400);

      const dbB1 = await prisma.attendanceBreak.findUnique({ where: { id: b1.id } });
      const dbB2 = await prisma.attendanceBreak.findUnique({ where: { id: b2.id } });
      expect(dbB1?.paidDurationSeconds).toBe(1800);
      expect(dbB1?.unpaidDurationSeconds).toBe(0);
      expect(dbB2?.paidDurationSeconds).toBe(1200);
      expect(dbB2?.unpaidDurationSeconds).toBe(0);
    });

    it('2.2 should share daily paid allowance across multiple sessions on the same day', async () => {
      // 60 minutes = 3600s total daily allowance
      const record = await createTestRecord({ dateStr: '2026-04-06', paidAllowanceMinutes: 60 });
      // Session 1: 09:00 to 13:00 with 45m break (2700s)
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-06T09:00:00.000Z',
        checkOut: '2026-04-06T13:00:00.000Z',
      });
      const b1 = await createBreak({
        recordId: record.id,
        start: '2026-04-06T10:30:00.000Z',
        end: '2026-04-06T11:15:00.000Z', // 45m = 2700s
      });

      // Session 2: 14:00 to 18:00 with 30m break (1800s) -> remaining allowance is 900s
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-06T14:00:00.000Z',
        checkOut: '2026-04-06T18:00:00.000Z',
      });
      const b2 = await createBreak({
        recordId: record.id,
        start: '2026-04-06T15:30:00.000Z',
        end: '2026-04-06T16:00:00.000Z', // 30m = 1800s
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      // Total paid break must equal 3600s (2700s from B1 + 900s from B2)
      expect(res.body.data.result.paidBreakDurationSeconds).toBe(3600);
      // Unpaid break is remaining 900s of B2
      expect(res.body.data.result.unpaidBreakDurationSeconds).toBe(900);

      const dbB2 = await prisma.attendanceBreak.findUnique({ where: { id: b2.id } });
      expect(dbB2?.paidDurationSeconds).toBe(900);
      expect(dbB2?.unpaidDurationSeconds).toBe(900);
    });

    it('2.3 should mark excess break duration beyond paid allowance as unpaid (5400s total: 3600s paid, 1800s unpaid)', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-07', paidAllowanceMinutes: 60 });
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-07T09:00:00.000Z',
        checkOut: '2026-04-07T18:00:00.000Z',
      });
      const b = await createBreak({
        recordId: record.id,
        start: '2026-04-07T12:00:00.000Z',
        end: '2026-04-07T13:30:00.000Z', // 90 mins = 5400s
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.paidBreakDurationSeconds).toBe(3600);
      expect(res.body.data.result.unpaidBreakDurationSeconds).toBe(1800);
    });

    it('2.4 should aggregate multiple unpaid breaks accurately', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-08', paidAllowanceMinutes: 0 }); // 0 allowance
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-08T09:00:00.000Z',
        checkOut: '2026-04-08T18:00:00.000Z',
      });
      await createBreak({
        recordId: record.id,
        start: '2026-04-08T11:00:00.000Z',
        end: '2026-04-08T11:10:00.000Z', // 600s
      });
      await createBreak({
        recordId: record.id,
        start: '2026-04-08T15:00:00.000Z',
        end: '2026-04-08T15:20:00.000Z', // 1200s
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.paidBreakDurationSeconds).toBe(0);
      expect(res.body.data.result.unpaidBreakDurationSeconds).toBe(1800);
    });

    it('2.5 should flag a break occurring entirely outside a session, quarantine it, and credit 0 paid/unpaid', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-09' });
      // Session: 09:00 to 13:00
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-09T09:00:00.000Z',
        checkOut: '2026-04-09T13:00:00.000Z',
      });
      // Break occurs at 14:00 to 14:30 (completely outside session)
      const b = await createBreak({
        recordId: record.id,
        start: '2026-04-09T14:00:00.000Z',
        end: '2026-04-09T14:30:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.hasIntegrityAnomaly).toBe(true);
      expect(res.body.data.result.anomalyType).toBe('BREAK_OUTSIDE_SESSION');
      expect(res.body.data.result.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);
      // Quarantined: not counted as paid or unpaid
      expect(res.body.data.result.paidBreakDurationSeconds).toBe(0);
      expect(res.body.data.result.unpaidBreakDurationSeconds).toBe(0);

      const dbBreak = await prisma.attendanceBreak.findUnique({ where: { id: b.id } });
      expect(dbBreak?.paidDurationSeconds).toBe(0);
      expect(dbBreak?.unpaidDurationSeconds).toBe(0);
    });

    it('2.6 should flag a break that starts inside but ends after checkout, quarantine it, and credit 0 paid/unpaid', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-25' });
      // Session: 09:00 to 17:00
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-25T09:00:00.000Z',
        checkOut: '2026-04-25T17:00:00.000Z',
      });
      // Break starts at 16:30 and ends at 17:30 (30m after checkout)
      const b = await createBreak({
        recordId: record.id,
        start: '2026-04-25T16:30:00.000Z',
        end: '2026-04-25T17:30:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.hasIntegrityAnomaly).toBe(true);
      expect(res.body.data.result.anomalyType).toBe('BREAK_NOT_CONTAINED_IN_SESSION');
      expect(res.body.data.result.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);
      expect(res.body.data.result.paidBreakDurationSeconds).toBe(0);
      expect(res.body.data.result.unpaidBreakDurationSeconds).toBe(0);

      const dbBreak = await prisma.attendanceBreak.findUnique({ where: { id: b.id } });
      expect(dbBreak?.paidDurationSeconds).toBe(0);
      expect(dbBreak?.unpaidDurationSeconds).toBe(0);
    });

    it('2.7 should flag a break that starts before check-in but ends inside, quarantine it, and credit 0 paid/unpaid', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-26' });
      // Session: 09:00 to 17:00
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-26T09:00:00.000Z',
        checkOut: '2026-04-26T17:00:00.000Z',
      });
      // Break starts at 08:30 and ends at 09:30 (starts before check-in)
      const b = await createBreak({
        recordId: record.id,
        start: '2026-04-26T08:30:00.000Z',
        end: '2026-04-26T09:30:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.hasIntegrityAnomaly).toBe(true);
      expect(res.body.data.result.anomalyType).toBe('BREAK_NOT_CONTAINED_IN_SESSION');
      expect(res.body.data.result.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);
      expect(res.body.data.result.paidBreakDurationSeconds).toBe(0);
      expect(res.body.data.result.unpaidBreakDurationSeconds).toBe(0);

      const dbBreak = await prisma.attendanceBreak.findUnique({ where: { id: b.id } });
      expect(dbBreak?.paidDurationSeconds).toBe(0);
      expect(dbBreak?.unpaidDurationSeconds).toBe(0);
    });

    it('2.8 should flag a break that spans across two distinct sessions, quarantine it, and credit 0 paid/unpaid', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-27' });
      // Session 1: 09:00 to 12:00
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-27T09:00:00.000Z',
        checkOut: '2026-04-27T12:00:00.000Z',
      });
      // Session 2: 13:00 to 18:00
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-27T13:00:00.000Z',
        checkOut: '2026-04-27T18:00:00.000Z',
      });
      // Break spans across both sessions: 11:30 to 13:30
      const b = await createBreak({
        recordId: record.id,
        start: '2026-04-27T11:30:00.000Z',
        end: '2026-04-27T13:30:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.hasIntegrityAnomaly).toBe(true);
      expect(res.body.data.result.anomalyType).toBe('BREAK_OVERLAPS_MULTIPLE_SESSIONS');
      expect(res.body.data.result.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);
      expect(res.body.data.result.paidBreakDurationSeconds).toBe(0);
      expect(res.body.data.result.unpaidBreakDurationSeconds).toBe(0);

      const dbBreak = await prisma.attendanceBreak.findUnique({ where: { id: b.id } });
      expect(dbBreak?.paidDurationSeconds).toBe(0);
      expect(dbBreak?.unpaidDurationSeconds).toBe(0);
    });

    it('2.9 should flag mutually overlapping breaks, quarantine them, and credit 0 paid/unpaid', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-28' });
      // Session: 09:00 to 18:00
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-28T09:00:00.000Z',
        checkOut: '2026-04-28T18:00:00.000Z',
      });
      // Break 1: 10:00 to 10:30
      const b1 = await createBreak({
        recordId: record.id,
        start: '2026-04-28T10:00:00.000Z',
        end: '2026-04-28T10:30:00.000Z',
      });
      // Break 2: 10:15 to 10:45 (overlapping by 15 mins)
      const b2 = await createBreak({
        recordId: record.id,
        start: '2026-04-28T10:15:00.000Z',
        end: '2026-04-28T10:45:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.hasIntegrityAnomaly).toBe(true);
      expect(res.body.data.result.anomalyType).toBe('OVERLAPPING_BREAKS');
      expect(res.body.data.result.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);
      expect(res.body.data.result.paidBreakDurationSeconds).toBe(0);
      expect(res.body.data.result.unpaidBreakDurationSeconds).toBe(0);

      const dbB1 = await prisma.attendanceBreak.findUnique({ where: { id: b1.id } });
      const dbB2 = await prisma.attendanceBreak.findUnique({ where: { id: b2.id } });
      expect(dbB1?.paidDurationSeconds).toBe(0);
      expect(dbB2?.paidDurationSeconds).toBe(0);
    });

    it('2.10 should flag an incomplete break (endedAt == null) as an unresolved anomaly and hold status in PENDING_RECONCILIATION', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-10' });
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-10T09:00:00.000Z',
        checkOut: '2026-04-10T18:00:00.000Z',
      });
      const activeBreak = await createBreak({
        recordId: record.id,
        start: '2026-04-10T12:00:00.000Z',
        end: null, // active/unresolved
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ isReconciled: true })
        .expect(200);

      expect(res.body.data.result.hasIntegrityAnomaly).toBe(true);
      expect(res.body.data.result.anomalyType).toBe('ACTIVE_BREAK_UNRESOLVED');
      expect(res.body.data.result.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);

      // Clean up active break
      await prisma.attendanceBreak.delete({ where: { id: activeBreak.id } });
    });

    it('2.11 should compute correct net working duration (Gross 28,800s - Unpaid 1,800s = Net 27,000s)', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-11', paidAllowanceMinutes: 0 }); // 0 allowance -> all unpaid
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-11T09:00:00.000Z',
        checkOut: '2026-04-11T17:00:00.000Z', // 8h = 28,800s
      });
      await createBreak({
        recordId: record.id,
        start: '2026-04-11T13:00:00.000Z',
        end: '2026-04-11T13:30:00.000Z', // 30m = 1800s
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.grossWorkingDurationSeconds).toBe(28800);
      expect(res.body.data.result.unpaidBreakDurationSeconds).toBe(1800);
      expect(res.body.data.result.netWorkingDurationSeconds).toBe(27000);
    });
  });

  // =========================================================================
  // SUITE 3: Geometric Overtime Calculation Engine (Scenarios 3.1-3.6)
  // =========================================================================
  describe('3. Geometric Overtime Calculation Engine', () => {
    it('3.1 should credit 0 overtime when actual post-shift work occurs without approved overtime request', async () => {
      // Shift ends at 18:00
      const record = await createTestRecord({ dateStr: '2026-04-12', shiftEndTime: '18:00:00' });
      // Employee worked until 20:00 (2 hours post-shift)
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-12T09:00:00.000Z',
        checkOut: '2026-04-12T20:00:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.verifiedOvertimeSeconds).toBe(0);
    });

    it('3.2 should credit 0 overtime when overtime is approved but employee performed 0 actual post-shift work', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-13', shiftEndTime: '18:00:00' });
      // Approved overtime 18:00 to 20:00
      await createOvertime({
        dateStr: '2026-04-13',
        start: '2026-04-13T18:00:00.000Z',
        end: '2026-04-13T20:00:00.000Z',
      });
      // Employee left exactly at 18:00
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-13T09:00:00.000Z',
        checkOut: '2026-04-13T18:00:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.verifiedOvertimeSeconds).toBe(0);
    });

    it('3.3 should calculate exact partial overlap between actual work and approved overtime window (4,500s)', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-14', shiftEndTime: '18:00:00' });
      // Approved overtime window: 18:00 to 20:00 (2 hours = 7200s)
      await createOvertime({
        dateStr: '2026-04-14',
        start: '2026-04-14T18:00:00.000Z',
        end: '2026-04-14T20:00:00.000Z',
      });
      // Employee worked until 19:15 (1h 15m post-shift = 4500s)
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-14T09:00:00.000Z',
        checkOut: '2026-04-14T19:15:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.verifiedOvertimeSeconds).toBe(4500);
    });

    it('3.4 should merge multiple overlapping overtime authorizations into a disjoint union without double-counting (9,000s = 2.5 hours)', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-15', shiftEndTime: '18:00:00' });
      // Overtime 1: 18:00 to 19:30 (90 mins)
      await createOvertime({
        dateStr: '2026-04-15',
        start: '2026-04-15T18:00:00.000Z',
        end: '2026-04-15T19:30:00.000Z',
      });
      // Overtime 2: 19:00 to 20:30 (90 mins, overlapping by 30 mins)
      await createOvertime({
        dateStr: '2026-04-15',
        start: '2026-04-15T19:00:00.000Z',
        end: '2026-04-15T20:30:00.000Z',
      });
      // Actual work: 18:00 to 20:30 (150 mins = 9000s)
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-15T09:00:00.000Z',
        checkOut: '2026-04-15T20:30:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      // Union of [18:00, 19:30] and [19:00, 20:30] is [18:00, 20:30] = 150m = 9000s (NOT 10800s)
      expect(res.body.data.result.verifiedOvertimeSeconds).toBe(9000);
    });

    it('3.5 should subtract exact unpaid break intervals falling inside the authorized overtime window (7200s - 1800s = 5400s)', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-16', shiftEndTime: '18:00:00', paidAllowanceMinutes: 0 }); // all unpaid
      // Approved overtime: 18:00 to 20:00 (2h = 7200s)
      await createOvertime({
        dateStr: '2026-04-16',
        start: '2026-04-16T18:00:00.000Z',
        end: '2026-04-16T20:00:00.000Z',
      });
      // Work: 09:00 to 20:00
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-16T09:00:00.000Z',
        checkOut: '2026-04-16T20:00:00.000Z',
      });
      // Unpaid break during overtime: 18:45 to 19:15 (30 mins = 1800s)
      await createBreak({
        recordId: record.id,
        start: '2026-04-16T18:45:00.000Z',
        end: '2026-04-16T19:15:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.verifiedOvertimeSeconds).toBe(5400);
    });

    it('3.6 should not deduct paid breaks during regular shift hours from overtime credit', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-17', shiftEndTime: '18:00:00', paidAllowanceMinutes: 60 });
      // Approved overtime: 18:00 to 20:00 (2h = 7200s)
      await createOvertime({
        dateStr: '2026-04-17',
        start: '2026-04-17T18:00:00.000Z',
        end: '2026-04-17T20:00:00.000Z',
      });
      // Work: 09:00 to 20:00
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-17T09:00:00.000Z',
        checkOut: '2026-04-17T20:00:00.000Z',
      });
      // Paid break during normal hours: 11:00 to 11:30 (30 mins)
      await createBreak({
        recordId: record.id,
        start: '2026-04-17T11:00:00.000Z',
        end: '2026-04-17T11:30:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      // Overtime must still be fully credited (7200s)
      expect(res.body.data.result.verifiedOvertimeSeconds).toBe(7200);
    });
  });

  // =========================================================================
  // SUITE 4: Attendance Status, Reconciliation & Snapshots (Scenarios 4.1-4.6)
  // =========================================================================
  describe('4. Attendance Status, Reconciliation & Snapshots', () => {
    it('4.1 should evaluate status as PRESENT when net working duration meets or exceeds full-day threshold (28,800s)', async () => {
      const record = await createTestRecord({
        dateStr: '2026-04-18',
        halfDaySeconds: 14400,
        fullDaySeconds: 28800,
      });
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-18T09:00:00.000Z',
        checkOut: '2026-04-18T17:00:00.000Z', // 8 hours = 28,800s
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.status).toBe(AttendanceStatus.PRESENT);
    });

    it('4.2 should evaluate status as HALF_DAY when net duration meets half-day threshold but is below full-day threshold (18,000s)', async () => {
      const record = await createTestRecord({
        dateStr: '2026-04-19',
        halfDaySeconds: 14400,
        fullDaySeconds: 28800,
      });
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-19T09:00:00.000Z',
        checkOut: '2026-04-19T14:00:00.000Z', // 5 hours = 18,000s
      });

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.status).toBe(AttendanceStatus.HALF_DAY);
    });

    it('4.3 should enforce absence cutoff on past shift: remain PENDING_RECONCILIATION before cutoff, transition to ABSENT on isReconciled: true', async () => {
      const record = await createTestRecord({
        dateStr: '2026-04-20',
        halfDaySeconds: 14400,
        fullDaySeconds: 28800,
      });
      // Only 2 hours worked (7,200s < 14,400s)
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-20T09:00:00.000Z',
        checkOut: '2026-04-20T11:00:00.000Z',
      });

      // Before EOD reconciliation cutoff:
      const pendingRes = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ isReconciled: false })
        .expect(200);

      expect(pendingRes.body.data.result.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);

      // Past date has already passed cutoff: Super Admin finalizing is authorized
      const absentRes = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ isReconciled: true })
        .expect(200);

      expect(absentRes.body.data.result.status).toBe(AttendanceStatus.ABSENT);
    });

    it('4.4 should reject premature reconciliation on ongoing shift before server-side cutoff time (400 Bad Request)', async () => {
      const todayStr = getAsiaKolkataDateString(new Date());
      // Shift ends far in future today (23:59)
      const record = await createTestRecord({
        dateStr: todayStr,
        shiftStartTime: '09:00:00',
        shiftEndTime: '23:59:00',
        halfDaySeconds: 14400,
        fullDaySeconds: 28800,
      });
      await createSession({
        recordId: record.id,
        checkIn: `${todayStr}T09:00:00.000Z`,
        checkOut: `${todayStr}T11:00:00.000Z`,
      });

      // Client attempting to force isReconciled: true before shift cutoff must be rejected
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ isReconciled: true })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Reconciliation cutoff has not elapsed for this shift');
    });

    it('4.5 should preserve historical snapshot authoritativeness even after parent ShiftDefinition is modified', async () => {
      // Record created with snapshot allowance = 60 mins (3600s)
      const record = await createTestRecord({ dateStr: '2026-04-21', paidAllowanceMinutes: 60 });
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-21T09:00:00.000Z',
        checkOut: '2026-04-21T18:00:00.000Z',
      });
      await createBreak({
        recordId: record.id,
        start: '2026-04-21T12:00:00.000Z',
        end: '2026-04-21T13:00:00.000Z', // 60 mins = 3600s
      });

      // Mutate parent ShiftDefinition in the database to 15 mins allowance
      await prisma.shiftDefinition.update({
        where: { id: testShiftId },
        data: {
          breakPolicySnapshot: JSON.stringify({
            paidAllowanceMinutes: 15,
            breakTypes: defaultBreakPolicy.breakTypes,
          }),
        },
      });

      // Recalculate existing record: must still read immutable snapshot (60 mins), NOT mutated shift definition (15 mins)
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(res.body.data.result.paidBreakDurationSeconds).toBe(3600);
      expect(res.body.data.result.unpaidBreakDurationSeconds).toBe(0);
    });

    it('4.6 should reject reconciliation finalization by ordinary shift manager lacking attendance.resolve_incident (403 Forbidden)', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-29' });
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-29T09:00:00.000Z',
        checkOut: '2026-04-29T11:00:00.000Z',
      });

      // PM has attendance.manage_shifts but lacks attendance.resolve_incident
      // Calling recalculate without isReconciled: true is allowed:
      const okRes = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(200);
      expect(okRes.body.success).toBe(true);

      // Attempting to finalize reconciliation with isReconciled: true must be rejected:
      const forbiddenRes = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ isReconciled: true });

      expect(forbiddenRes.status).toBe(403);

      expect(forbiddenRes.body.success).toBe(false);
      expect(forbiddenRes.body.message).toContain('attendance.resolve_incident');
    });
  });

  // =========================================================================
  // SUITE 5: Real MySQL Concurrency & Lock Serialization (Scenarios 5.1-5.5)
  // =========================================================================
  describe('5. Real MySQL Concurrency & Lock Serialization', () => {
    it('5.1 should be strictly idempotent (second recalculation yields identical result and writes zero duplicate audit entries)', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-22' });
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-22T09:00:00.000Z',
        checkOut: '2026-04-22T17:00:00.000Z',
      });

      // Run 1: updates record and creates audit entry
      const run1 = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(run1.body.data.updated).toBe(true);

      const auditCountBefore = await prisma.auditLog.count({
        where: {
          module: 'ATTENDANCE',
          entityType: 'AttendanceRecord',
          entityId: record.id,
        },
      });

      // Run 2: exact same calculation parameters
      const run2 = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({})
        .expect(200);

      expect(run2.body.data.updated).toBe(false);
      expect(run2.body.data.result.grossWorkingDurationSeconds).toBe(
        run1.body.data.result.grossWorkingDurationSeconds,
      );

      const auditCountAfter = await prisma.auditLog.count({
        where: {
          module: 'ATTENDANCE',
          entityType: 'AttendanceRecord',
          entityId: record.id,
        },
      });

      // No new audit log must be written for an unchanged recalculation
      expect(auditCountAfter).toBe(auditCountBefore);
    });

    it('5.2 should handle concurrent recalculation vs recalculation safely under Level 3/5/7/8 locks without deadlocks', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-23' });
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-23T09:00:00.000Z',
        checkOut: '2026-04-23T17:00:00.000Z',
      });

      // Concurrently fire 2 recalculation requests with Level 3/5/7/8 row locks
      const [res1, res2] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/attendance/records/${record.id}/recalculate`)
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({ isReconciled: true }),
        request(app.getHttpServer())
          .post(`/api/attendance/records/${record.id}/recalculate`)
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({ isReconciled: true }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body.data.result.grossWorkingDurationSeconds).toBe(28800);
      expect(res2.body.data.result.grossWorkingDurationSeconds).toBe(28800);
    });

    it('5.3 should handle concurrent checkout vs recalculation safely without deadlock under monotonic lock acquisition', async () => {
      // 1. Employee checks in to start an active session today
      const todayStr = getAsiaKolkataDateString(new Date());

      // Clean up any existing active session or breaks
      await prisma.attendanceBreak.deleteMany({ where: { userId: employeeId, endedAt: null } });
      await prisma.attendanceSession.deleteMany({ where: { userId: employeeId, status: AttendanceSessionStatus.ACTIVE } });

      // Assign shift to employee if not assigned
      const shiftAssignment = await prisma.employeeShiftAssignment.findFirst({
        where: { userId: employeeId, shiftDefinitionId: testShiftId },
      });
      if (!shiftAssignment) {
        const empProfile = await prisma.employeeProfile.findUniqueOrThrow({ where: { userId: employeeId } });
        await prisma.employeeShiftAssignment.create({
          data: {
            employeeProfileId: empProfile.id,
            userId: employeeId,
            shiftDefinitionId: testShiftId,
            startDate: parseDateOnly(todayStr),
          },
        });
      }

      // Check-in via API
      const checkInRes = await request(app.getHttpServer())
        .post('/api/attendance/check-in')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(201);

      const recordId = checkInRes.body.data.record.id;

      // 2. Concurrently fire POST check-out and POST recalculate
      const [checkOutRes, recalcRes] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/attendance/check-out')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({}),
        request(app.getHttpServer())
          .post(`/api/attendance/records/${recordId}/recalculate`)
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({}),
      ]);

      // Both operations must finish without MySQL deadlock (no ER_LOCK_DEADLOCK)
      expect(checkOutRes.status).toBe(200);
      expect(recalcRes.status).toBe(200);

      // Verify final session status is COMPLETED
      const finalSession = await prisma.attendanceSession.findFirst({
        where: { attendanceRecordId: recordId },
      });
      expect(finalSession?.status).toBe(AttendanceSessionStatus.COMPLETED);
      expect(finalSession?.checkOutAt).not.toBeNull();
    });

    it('5.5 should handle concurrent end-break vs recalculation safely without deadlock under monotonic lock acquisition', async () => {
      // 1. Check in and start break
      const checkInRes = await request(app.getHttpServer())
        .post('/api/attendance/check-in')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(201);

      const recordId = checkInRes.body.data.record.id;

      await request(app.getHttpServer())
        .post('/api/attendance/breaks/start')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ breakTypeId: 'TEA' })
        .expect(201);

      // 2. Concurrently fire POST breaks/end and POST recalculate
      const [endBreakRes, recalcRes] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/attendance/breaks/end')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({}),
        request(app.getHttpServer())
          .post(`/api/attendance/records/${recordId}/recalculate`)
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({}),
      ]);

      expect(endBreakRes.status).toBe(200);
      expect(recalcRes.status).toBe(200);

      // Clean up: conclude session
      await request(app.getHttpServer())
        .post('/api/attendance/check-out')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(200);
    });

    it('5.6 should reject recalculation by non-privileged employee lacking attendance.manage_shifts (403 Forbidden)', async () => {
      const record = await createTestRecord({ dateStr: '2026-04-24' });
      await createSession({
        recordId: record.id,
        checkIn: '2026-04-24T09:00:00.000Z',
        checkOut: '2026-04-24T17:00:00.000Z',
      });

      // Employee token (DEVELOPER) does not have attendance.manage_shifts
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/records/${record.id}/recalculate`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(403);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });
});
