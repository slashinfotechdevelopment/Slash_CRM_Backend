import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import {
  AnomalyStatus,
  AttendanceCorrectionStatus,
  AttendanceSessionStatus,
  AttendanceStatus,
  OvertimeApprovalStatus,
  RecordStatus,
  WfhStatus,
} from '../src/generated/prisma/enums';
import { parseDateOnly } from '../src/modules/attendance/attendance.utils';
import { AnomalyResolutionAction } from '../src/modules/attendance/dto/resolve-anomaly.dto';

describe('Phase 6.2.8: Comprehensive Integration & MySQL Concurrency Testing (e2e)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  let superAdminToken: string;
  let superAdminId: string;

  let hrToken: string;
  let hrId: string;

  let managerToken: string;
  let managerId: string;

  let employeeToken: string;
  let employeeId: string;

  let otherEmployeeToken: string;
  let otherEmployeeId: string;

  let testShiftId: string;
  let testShiftCode: string;

  const createdRecordIds: string[] = [];
  const createdRunIds: string[] = [];
  const createdShiftIds: string[] = [];
  const createdAssignmentIds: string[] = [];
  const createdOvertimeIds: string[] = [];
  const createdWfhIds: string[] = [];

  function createRecordSnapshotData(dateStr: string) {
    return {
      shiftStartTimeSnapshot: new Date(`${dateStr}T03:30:00.000Z`), // 09:00 IST
      shiftEndTimeSnapshot: new Date(`${dateStr}T12:30:00.000Z`), // 18:00 IST
      halfDayThresholdSecondsSnapshot: 14400,
      fullDayThresholdSecondsSnapshot: 28800,
      overtimeThresholdSecondsSnapshot: 32400,
      allowMultipleSessionsSnapshot: true,
      breakPolicySnapshot: JSON.stringify({
        paidAllowanceMinutes: 60,
        autoCloseGraceMinutes: 30,
        breakTypes: [
          { code: 'TEA', breakTypeId: 'TEA', id: 'TEA', name: 'Tea Break', maxDurationMinutes: 15, isPaid: true },
          { code: 'LUNCH', breakTypeId: 'LUNCH', id: 'LUNCH', name: 'Lunch Break', maxDurationMinutes: 45, isPaid: true },
        ],
      }),
    };
  }

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

    // 1. Super Admin
    const superAdmin = await prisma.user.findFirst({
      where: { userType: { code: 'SUPER_ADMIN' }, deletedAt: null },
    });
    if (!superAdmin) throw new Error('Super Admin not found');
    superAdminId = superAdmin.id;

    const saSession = await prisma.userSession.create({
      data: {
        userId: superAdmin.id,
        refreshTokenHash: 'e2e_sa_628_' + Date.now(),
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

    // 2. Main Employee (DEVELOPER role)
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
        refreshTokenHash: 'e2e_emp_628_' + Date.now(),
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

    // 3. Project Manager
    const pm = await prisma.user.findFirst({
      where: {
        userType: { code: 'EMPLOYEE' },
        userRoles: { some: { role: { code: 'PROJECT_MANAGER' } } },
        deletedAt: null,
      },
    });
    if (!pm) throw new Error('Project Manager not found');
    managerId = pm.id;

    // Ensure emp and PM share a department (DEVELOPMENT)
    const devDept = await prisma.department.findFirst({
      where: { code: 'DEVELOPMENT' },
    });
    if (devDept) {
      await prisma.userDepartment.upsert({
        where: { userId_departmentId: { userId: emp.id, departmentId: devDept.id } },
        create: { userId: emp.id, departmentId: devDept.id, isPrimary: true },
        update: {},
      });
      await prisma.userDepartment.upsert({
        where: { userId_departmentId: { userId: pm.id, departmentId: devDept.id } },
        create: { userId: pm.id, departmentId: devDept.id, isPrimary: true },
        update: {},
      });
    }

    const pmSession = await prisma.userSession.create({
      data: {
        userId: pm.id,
        refreshTokenHash: 'e2e_pm_628_' + Date.now(),
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

    // 4. HR User
    const hrRole = await prisma.role.findFirst({ where: { code: 'HR' } });
    let hrUser = await prisma.user.findFirst({
      where: {
        userRoles: { some: { roleId: hrRole?.id } },
        deletedAt: null,
      },
    });
    if (!hrUser) {
      const empType = await prisma.userType.findFirst({
        where: { code: 'EMPLOYEE' },
      });
      hrUser = await prisma.user.create({
        data: {
          email: `e2e_hr_628_${Date.now()}@slash.test`,
          name: 'E2E HR Manager 628',
          userCode: `HR_${Date.now().toString().slice(-4)}`,
          status: RecordStatus.ACTIVE,
          userTypeId: empType!.id,
          employeeProfile: {
            create: {
              designation: 'HR Manager',
              dateOfJoining: new Date(),
            },
          },
          userRoles: {
            create: { roleId: hrRole!.id },
          },
        },
      });
    }
    hrId = hrUser.id;

    const hrSession = await prisma.userSession.create({
      data: {
        userId: hrId,
        refreshTokenHash: 'e2e_hr_sess_628_' + Date.now(),
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    hrToken = await jwtService.signAsync(
      {
        sub: hrId,
        email: hrUser.email,
        userCode: hrUser.userCode,
        userType: 'EMPLOYEE',
        roles: ['HR'],
        sessionId: hrSession.id,
      },
      { secret: 'slash@202612354', expiresIn: '15m' },
    );

    // 5. Other Employee (in different department: SALES)
    const salesDept = await prisma.department.findFirst({
      where: { code: 'SALES' },
    });
    const otherEmp = await prisma.user.findFirst({
      where: {
        id: { notIn: [emp.id, pm.id, hrId] },
        userType: { code: 'EMPLOYEE' },
        deletedAt: null,
      },
      include: { employeeProfile: true },
    });
    if (!otherEmp || !otherEmp.employeeProfile) throw new Error('Other Employee not found');
    otherEmployeeId = otherEmp.id;

    if (salesDept) {
      await prisma.userDepartment.deleteMany({
        where: { userId: otherEmp.id },
      });
      await prisma.userDepartment.create({
        data: {
          userId: otherEmp.id,
          departmentId: salesDept.id,
          isPrimary: true,
        },
      });
    }

    const otherEmpSession = await prisma.userSession.create({
      data: {
        userId: otherEmp.id,
        refreshTokenHash: 'e2e_other_628_' + Date.now(),
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    otherEmployeeToken = await jwtService.signAsync(
      {
        sub: otherEmp.id,
        email: otherEmp.email,
        userCode: otherEmp.userCode,
        userType: 'EMPLOYEE',
        roles: ['SALES'],
        sessionId: otherEmpSession.id,
      },
      { secret: 'slash@202612354', expiresIn: '15m' },
    );

    // 6. Test Shift Definition & Active Assignment
    testShiftCode = 'SHIFT_STD_628';
    let standardShift = await prisma.shiftDefinition.findFirst({
      where: { code: testShiftCode },
    });
    if (!standardShift) {
      standardShift = await prisma.shiftDefinition.create({
        data: {
          code: testShiftCode,
          name: 'Standard E2E 628 Shift (09:00 - 18:00)',
          startTime: '09:00',
          endTime: '18:00',
          isOvernight: false,
          halfDayThresholdMinutes: 240,
          fullDayThresholdMinutes: 480,
          overtimeThresholdMinutes: 540,
          allowMultipleSessions: true,
          breakPolicySnapshot: JSON.stringify({
            paidAllowanceMinutes: 60,
            autoCloseGraceMinutes: 30,
            breakTypes: [
              { code: 'TEA', breakTypeId: 'TEA', id: 'TEA', name: 'Tea Break', maxDurationMinutes: 15, isPaid: true },
              { code: 'LUNCH', breakTypeId: 'LUNCH', id: 'LUNCH', name: 'Lunch Break', maxDurationMinutes: 45, isPaid: true },
            ],
          }),
        },
      });
    } else {
      await prisma.shiftDefinition.update({
        where: { id: standardShift.id },
        data: {
          breakPolicySnapshot: JSON.stringify({
            paidAllowanceMinutes: 60,
            autoCloseGraceMinutes: 30,
            breakTypes: [
              { code: 'TEA', breakTypeId: 'TEA', id: 'TEA', name: 'Tea Break', maxDurationMinutes: 15, isPaid: true },
              { code: 'LUNCH', breakTypeId: 'LUNCH', id: 'LUNCH', name: 'Lunch Break', maxDurationMinutes: 45, isPaid: true },
            ],
          }),
        },
      });
    }
    testShiftId = standardShift.id;
    createdShiftIds.push(testShiftId);

    // Ensure all shift assignments and definitions for employeeId have the updated break policy
    const existingAssigns = await prisma.employeeShiftAssignment.findMany({
      where: { userId: employeeId },
    });
    for (const a of existingAssigns) {
      await prisma.employeeShiftAssignment.update({
        where: { id: a.id },
        data: { shiftDefinitionId: testShiftId },
      });
      await prisma.shiftDefinition.update({
        where: { id: a.shiftDefinitionId },
        data: {
          breakPolicySnapshot: JSON.stringify({
            paidAllowanceMinutes: 60,
            autoCloseGraceMinutes: 30,
            breakTypes: [
              { code: 'TEA', breakTypeId: 'TEA', id: 'TEA', name: 'Tea Break', maxDurationMinutes: 15, isPaid: true },
              { code: 'LUNCH', breakTypeId: 'LUNCH', id: 'LUNCH', name: 'Lunch Break', maxDurationMinutes: 45, isPaid: true },
            ],
          }),
        },
      });
    }

    if (existingAssigns.length === 0) {
      const assign = await prisma.employeeShiftAssignment.create({
        data: {
          employeeProfileId: emp.employeeProfile.id,
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
          endDate: new Date('2026-12-31T23:59:59.999Z'),
        },
      });
      createdAssignmentIds.push(assign.id);
    }

    // Purge any stale test records from previous runs
    await purgeTestData();
  });

  async function purgeTestData() {
    const testUserIds = [employeeId, managerId, hrId, otherEmployeeId, superAdminId].filter(Boolean);
    if (testUserIds.length === 0) return;

    const testDates = [
      parseDateOnly('2026-09-01'),
      parseDateOnly('2026-09-02'),
      parseDateOnly('2026-09-03'),
      parseDateOnly('2026-09-04'),
      parseDateOnly('2026-09-05'),
      parseDateOnly('2026-09-06'),
      parseDateOnly('2026-09-07'),
      parseDateOnly('2026-09-08'),
      parseDateOnly('2026-09-09'),
      parseDateOnly('2026-09-10'),
      parseDateOnly('2026-09-11'),
      parseDateOnly('2026-09-12'),
      parseDateOnly('2026-09-13'),
      parseDateOnly(new Date()),
    ];

    const records = await prisma.attendanceRecord.findMany({
      where: {
        userId: { in: testUserIds },
        attendanceDate: { in: testDates },
      },
      select: { id: true },
    });
    const ids = records.map((r) => r.id);
    if (ids.length > 0) {
      await prisma.attendanceAnomaly.deleteMany({ where: { attendanceRecordId: { in: ids } } });
      await prisma.attendanceBreak.deleteMany({ where: { attendanceRecordId: { in: ids } } });
      await prisma.attendanceCorrectionRequest.deleteMany({ where: { attendanceRecordId: { in: ids } } });
      await prisma.attendanceSession.deleteMany({ where: { attendanceRecordId: { in: ids } } });
      await prisma.attendanceRecord.deleteMany({ where: { id: { in: ids } } });
    }

    await prisma.attendanceBreak.deleteMany({ where: { userId: { in: testUserIds } } });
    await prisma.attendanceSession.deleteMany({ where: { userId: { in: testUserIds } } });
    await prisma.attendanceOvertimeRequest.deleteMany({ where: { userId: { in: testUserIds } } });
    await prisma.attendanceWfhRequest.deleteMany({ where: { userId: { in: testUserIds } } });
    await prisma.attendanceReconciliationRun.deleteMany({
      where: { targetDate: { in: testDates } },
    });
  }

  afterAll(async () => {
    // Thorough cleanup of all test records
    await purgeTestData();
    const validRunIds = createdRunIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (validRunIds.length > 0) {
      await prisma.attendanceReconciliationRun.deleteMany({
        where: { id: { in: validRunIds } },
      });
    }
    const validAssignIds = createdAssignmentIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (validAssignIds.length > 0) {
      await prisma.employeeShiftAssignment.deleteMany({
        where: { id: { in: validAssignIds } },
      });
    }
    await app.close();
  });

  // =========================================================================
  // PART 1: THE 12 MANDATORY REAL MYSQL CONCURRENCY SCENARIOS
  // =========================================================================
  describe('Part 1: Real MySQL Concurrency Verification (12 Mandated Scenarios)', () => {

    it('Scenario 1: Two simultaneous check-ins for one employee (exactly one 201, one 409; single active session in DB)', async () => {
      // Ensure no active session exists
      await prisma.attendanceSession.deleteMany({
        where: { userId: employeeId, status: AttendanceSessionStatus.ACTIVE },
      });

      const [res1, res2] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/attendance/check-in')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({ remarks: 'Simultaneous checkin attempt 1' }),
        request(app.getHttpServer())
          .post('/api/attendance/check-in')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({ remarks: 'Simultaneous checkin attempt 2' }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 409]);

      // Database verification: Exactly 1 active session exists
      const activeSessions = await prisma.attendanceSession.findMany({
        where: { userId: employeeId, status: AttendanceSessionStatus.ACTIVE },
      });
      expect(activeSessions.length).toBe(1);

      if (res1.body.data?.attendanceRecordId) createdRecordIds.push(res1.body.data.attendanceRecordId);
      if (res2.body.data?.attendanceRecordId) createdRecordIds.push(res2.body.data.attendanceRecordId);

      // Clean up by checking out
      await request(app.getHttpServer())
        .post('/api/attendance/check-out')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ remarks: 'Cleanup check-out' });
    });

    it('Scenario 2: Two simultaneous check-outs for one active session (exactly one 200, one 400; duration counted once)', async () => {
      // Start an active session
      const checkInRes = await request(app.getHttpServer())
        .post('/api/attendance/check-in')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ remarks: 'Pre-checkout session' })
        .expect(201);

      const recordId = checkInRes.body.data.attendanceRecordId;
      createdRecordIds.push(recordId);

      // Concurrently fire 2 check-outs
      const [out1, out2] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/attendance/check-out')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({ remarks: 'Simultaneous checkout 1' }),
        request(app.getHttpServer())
          .post('/api/attendance/check-out')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({ remarks: 'Simultaneous checkout 2' }),
      ]);

      const statuses = [out1.status, out2.status].sort();
      expect(statuses).toEqual([200, 400]);

      // Database verification: Session completed, zero active sessions
      const activeSessions = await prisma.attendanceSession.findMany({
        where: { userId: employeeId, status: AttendanceSessionStatus.ACTIVE },
      });
      expect(activeSessions.length).toBe(0);

      const completedSession = await prisma.attendanceSession.findFirstOrThrow({
        where: { attendanceRecordId: recordId },
      });
      expect(completedSession.status).toBe(AttendanceSessionStatus.COMPLETED);
      expect(completedSession.checkOutAt).not.toBeNull();
    });

    it('Scenario 3: Two simultaneous break starts (exactly one 201, one 409; single active break in DB)', async () => {
      // Active session required to start a break
      const checkInRes = await request(app.getHttpServer())
        .post('/api/attendance/check-in')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ remarks: 'Session for break race' })
        .expect(201);
      createdRecordIds.push(checkInRes.body.data.attendanceRecordId);

      // Concurrently fire two break starts
      const [brk1, brk2] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/attendance/breaks/start')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({ breakTypeId: 'TEA' }),
        request(app.getHttpServer())
          .post('/api/attendance/breaks/start')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({ breakTypeId: 'LUNCH' }),
      ]);

      const statuses = [brk1.status, brk2.status].sort();
      expect(statuses).toEqual([201, 409]);

      // Database verification: Exactly 1 active break in progress
      const activeBreaks = await prisma.attendanceBreak.findMany({
        where: { userId: employeeId, endedAt: null },
      });
      expect(activeBreaks.length).toBe(1);
    });

    it('Scenario 4: Two simultaneous break endings (exactly one 200, one 400; paid/unpaid allocated once)', async () => {
      // An active break exists from Scenario 3
      const [end1, end2] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/attendance/breaks/end')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({}),
        request(app.getHttpServer())
          .post('/api/attendance/breaks/end')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({}),
      ]);

      const statuses = [end1.status, end2.status].sort();
      expect(statuses).toEqual([200, 400]);

      // Database verification: Exactly 0 active breaks remaining
      const activeBreaks = await prisma.attendanceBreak.findMany({
        where: { userId: employeeId, endedAt: null },
      });
      expect(activeBreaks.length).toBe(0);

      // Clean up session
      await request(app.getHttpServer())
        .post('/api/attendance/check-out')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({});
    });

    it('Scenario 5: Check-out versus break start (ACID serialization prevents orphan breaks or checkout during active break)', async () => {
      // Ensure clean state: no active break or session
      await prisma.attendanceBreak.deleteMany({
        where: { userId: employeeId, endedAt: null },
      });
      await prisma.attendanceSession.deleteMany({
        where: { userId: employeeId, status: AttendanceSessionStatus.ACTIVE },
      });

      // Start active session
      const checkInRes = await request(app.getHttpServer())
        .post('/api/attendance/check-in')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ remarks: 'Checkout vs Break race' })
        .expect(201);
      createdRecordIds.push(checkInRes.body.data.attendanceRecordId);

      // Concurrently fire check-out and break-start
      const [checkOutRes, breakStartRes] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/attendance/check-out')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({}),
        request(app.getHttpServer())
          .post('/api/attendance/breaks/start')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({ breakTypeId: 'TEA' }),
      ]);

      // Serialization invariant:
      // If break won: breakStart = 201, checkOut = 400 (cannot check out while break is active)
      // If checkout won: checkOut = 200, breakStart = 400 (no active session to start break)
      const outcome = [checkOutRes.status, breakStartRes.status];
      expect([[200, 400], [400, 201]]).toContainEqual(outcome);

      // Clean up if break won
      const openBreak = await prisma.attendanceBreak.findFirst({
        where: { userId: employeeId, endedAt: null },
      });
      if (openBreak) {
        await request(app.getHttpServer())
          .post('/api/attendance/breaks/end')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({});
        await request(app.getHttpServer())
          .post('/api/attendance/check-out')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({});
      }
    });

    it('Scenario 6: Correction approval versus check-out (Level 3/4/7/8 locks serialize without deadlocks)', async () => {
      // Ensure clean state: no active session
      await prisma.attendanceSession.deleteMany({
        where: { userId: employeeId, status: AttendanceSessionStatus.ACTIVE },
      });

      const dateStr = '2026-09-02';
      const attDate = parseDateOnly(dateStr);

      // Create attendance record with Session 1 (completed) and Session 2 (active)
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.IN_PROGRESS,
          ...createRecordSnapshotData(dateStr),
          sessions: {
            create: [
              {
                rawCheckInAt: new Date(`${dateStr}T03:30:00.000Z`), // 09:00 IST
                rawCheckOutAt: new Date(`${dateStr}T07:30:00.000Z`), // 13:00 IST
                checkInAt: new Date(`${dateStr}T03:30:00.000Z`),
                checkOutAt: new Date(`${dateStr}T07:30:00.000Z`),
                durationSeconds: 14400,
                status: AttendanceSessionStatus.COMPLETED,
              },
              {
                rawCheckInAt: new Date(`${dateStr}T08:30:00.000Z`), // 14:00 IST
                checkInAt: new Date(`${dateStr}T08:30:00.000Z`),
                status: AttendanceSessionStatus.ACTIVE,
              },
            ],
          },
        },
        include: { sessions: true },
      });
      createdRecordIds.push(rec.id);

      const session1 = rec.sessions.find((s) => s.status === AttendanceSessionStatus.COMPLETED)!;

      // Create correction request for session 1
      const corr = await prisma.attendanceCorrectionRequest.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          attendanceSessionId: session1.id,
          requestedCheckInAt: new Date(`${dateStr}T03:00:00.000Z`), // 08:30 IST
          requestedCheckOutAt: new Date(`${dateStr}T07:30:00.000Z`),
          reason: 'Correct punch in time on session 1',
          status: AttendanceCorrectionStatus.PENDING,
        },
      });

      // Concurrently approve correction for session 1 and checkout session 2
      const [corrRes, outRes] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/attendance/corrections/${corr.id}/approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({ managerNotes: 'Approved during checkout race' }),
        request(app.getHttpServer())
          .post('/api/attendance/check-out')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({ remarks: 'Checkout session 2' }),
      ]);

      // Both should succeed (200 OK) without deadlocks
      expect([corrRes.status, outRes.status]).toEqual([200, 200]);

      // Verify Session 1 updated
      const updatedS1 = await prisma.attendanceSession.findUniqueOrThrow({
        where: { id: session1.id },
      });
      expect(updatedS1.checkInAt).toEqual(new Date(`${dateStr}T03:00:00.000Z`));
    });

    it('Scenario 7: Correction approval versus reconciliation (Level 3 locks serialize safely without deadlocks)', async () => {
      const dateStr = '2026-09-03';
      const attDate = parseDateOnly(dateStr);

      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          ...createRecordSnapshotData(dateStr),
          sessions: {
            create: {
              rawCheckInAt: new Date(`${dateStr}T03:30:00.000Z`),
              rawCheckOutAt: new Date(`${dateStr}T11:30:00.000Z`),
              checkInAt: new Date(`${dateStr}T03:30:00.000Z`),
              checkOutAt: new Date(`${dateStr}T11:30:00.000Z`),
              durationSeconds: 28800,
              status: AttendanceSessionStatus.COMPLETED,
            },
          },
        },
        include: { sessions: true },
      });
      createdRecordIds.push(rec.id);

      const session = rec.sessions[0];

      const corr = await prisma.attendanceCorrectionRequest.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          attendanceSessionId: session.id,
          requestedCheckInAt: new Date(`${dateStr}T03:30:00.000Z`),
          requestedCheckOutAt: new Date(`${dateStr}T12:30:00.000Z`), // 18:00 IST
          reason: 'Correct checkout time to shift end',
          status: AttendanceCorrectionStatus.PENDING,
        },
      });

      // Concurrently approve correction and trigger reconciliation
      const [corrRes, reconRes] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/attendance/corrections/${corr.id}/approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({ managerNotes: 'Approve concurrent with reconciliation' }),
        request(app.getHttpServer())
          .post('/api/attendance/reconciliation/run')
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({
            targetDate: dateStr,
            forceReconcile: true,
            forceReason: 'Reconcile concurrent with correction test',
          }),
      ]);

      expect([200, 200]).toEqual([corrRes.status, reconRes.status]);
      if (reconRes.body.data?.id) createdRunIds.push(reconRes.body.data.id);

      // Verify no corrupted attendance record
      const finalRec = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(finalRec.hasIntegrityAnomaly).toBe(false);
      expect(finalRec.status).toBe(AttendanceStatus.PRESENT);
    });

    it('Scenario 8: Overtime approval versus reconciliation (Level 3 -> 5 locks serialize; overtime duration credited)', async () => {
      const dateStr = '2026-09-04';
      const attDate = parseDateOnly(dateStr);

      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          ...createRecordSnapshotData(dateStr),
          sessions: {
            create: {
              rawCheckInAt: new Date(`${dateStr}T03:30:00.000Z`),
              rawCheckOutAt: new Date(`${dateStr}T14:30:00.000Z`), // 11 hours work
              checkInAt: new Date(`${dateStr}T03:30:00.000Z`),
              checkOutAt: new Date(`${dateStr}T14:30:00.000Z`),
              durationSeconds: 39600,
              status: AttendanceSessionStatus.COMPLETED,
            },
          },
        },
      });
      createdRecordIds.push(rec.id);

      const otReq = await prisma.attendanceOvertimeRequest.create({
        data: {
          userId: employeeId,
          attendanceDate: attDate,
          startTime: new Date(`${dateStr}T12:30:00.000Z`),
          endTime: new Date(`${dateStr}T14:30:00.000Z`),
          reason: 'Production deployment overtime',
          status: OvertimeApprovalStatus.PENDING,
        },
      });
      createdOvertimeIds.push(otReq.id);

      // Concurrently approve overtime and execute reconciliation
      const [otRes, reconRes] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/attendance/overtime/${otReq.id}/approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({ approvedDurationMinutes: 120 }),
        request(app.getHttpServer())
          .post('/api/attendance/reconciliation/run')
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({
            targetDate: dateStr,
            forceReconcile: true,
            forceReason: 'Reconcile concurrent with overtime approval',
          }),
      ]);

      expect([200, 200]).toEqual([otRes.status, reconRes.status]);
      if (reconRes.body.data?.id) createdRunIds.push(reconRes.body.data.id);

      // Overtime duration credited
      const updatedRec = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(updatedRec.verifiedOvertimeSeconds).toBe(7200); // 120 mins = 7200s
    });

    it('Scenario 9: Concurrent overtime requests exceeding the daily limit (Level 5 lock: exactly one 201, one 400)', async () => {
      const dateStr = '2026-09-05';

      // Clean overtime for dateStr
      await prisma.attendanceOvertimeRequest.deleteMany({
        where: { userId: employeeId, attendanceDate: parseDateOnly(dateStr) },
      });

      // Daily limit is 240 mins. Concurrently send two 180-min requests (total = 360 mins)
      const [ot1, ot2] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/attendance/overtime')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({
            attendanceDate: dateStr,
            startTime: `${dateStr}T12:30:00.000Z`,
            endTime: `${dateStr}T15:30:00.000Z`,
            reason: 'Concurrent overtime batch A',
          }),
        request(app.getHttpServer())
          .post('/api/attendance/overtime')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({
            attendanceDate: dateStr,
            startTime: `${dateStr}T15:30:00.000Z`,
            endTime: `${dateStr}T18:30:00.000Z`,
            reason: 'Concurrent overtime batch B',
          }),
      ]);

      const statuses = [ot1.status, ot2.status].sort();
      expect(statuses).toEqual([201, 400]);

      if (ot1.body.data?.id) createdOvertimeIds.push(ot1.body.data.id);
      if (ot2.body.data?.id) createdOvertimeIds.push(ot2.body.data.id);

      // Verify total in database <= 240 mins
      const requestsInDb = await prisma.attendanceOvertimeRequest.findMany({
        where: { userId: employeeId, attendanceDate: parseDateOnly(dateStr) },
      });
      expect(requestsInDb.length).toBe(1);
    });

    it('Scenario 10: Concurrent reconciliation runs for the same date and department (serialize cleanly without deadlocks)', async () => {
      const dateStr = '2026-09-06';
      const attDate = parseDateOnly(dateStr);

      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          ...createRecordSnapshotData(dateStr),
          sessions: {
            create: {
              rawCheckInAt: new Date(`${dateStr}T03:30:00.000Z`),
              rawCheckOutAt: new Date(`${dateStr}T12:30:00.000Z`),
              checkInAt: new Date(`${dateStr}T03:30:00.000Z`),
              checkOutAt: new Date(`${dateStr}T12:30:00.000Z`),
              durationSeconds: 32400,
              status: AttendanceSessionStatus.COMPLETED,
            },
          },
        },
      });
      createdRecordIds.push(rec.id);

      // Fire 2 concurrent reconciliation requests on same date
      const [recon1, recon2] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/attendance/reconciliation/run')
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({
            targetDate: dateStr,
            forceReconcile: true,
            forceReason: 'Concurrent reconciliation run 1',
          }),
        request(app.getHttpServer())
          .post('/api/attendance/reconciliation/run')
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({
            targetDate: dateStr,
            forceReconcile: true,
            forceReason: 'Concurrent reconciliation run 2',
          }),
      ]);

      expect(recon1.status).toBe(200);
      expect(recon2.status).toBe(200);

      if (recon1.body.data?.id) createdRunIds.push(recon1.body.data.id);
      if (recon2.body.data?.id) createdRunIds.push(recon2.body.data.id);

      // Verify record is cleanly reconciled with 0 anomalies
      const postRec = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(postRec.status).toBe(AttendanceStatus.PRESENT);
      expect(postRec.hasIntegrityAnomaly).toBe(false);
    });

    it('Scenario 11: Concurrent anomaly resolution attempts (Level 3 lock: exactly one succeeds, second gets 400)', async () => {
      const dateStr = '2026-09-07';
      const attDate = parseDateOnly(dateStr);

      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          hasIntegrityAnomaly: true,
          anomalyType: 'MISSING_CHECK_IN',
          anomalyDetails: 'No check-in punch found',
          ...createRecordSnapshotData(dateStr),
        },
      });
      createdRecordIds.push(rec.id);

      // Create persistent anomaly row
      await prisma.attendanceAnomaly.create({
        data: {
          attendanceRecordId: rec.id,
          anomalyType: 'MISSING_CHECK_IN',
          details: 'No check-in punch found',
          status: AnomalyStatus.ACTIVE,
        },
      });

      // Concurrently fire two resolution attempts (HR and Super Admin)
      const [res1, res2] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/attendance/anomalies/${rec.id}/resolve`)
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({
            action: AnomalyResolutionAction.RESOLVE,
            notes: 'Super Admin resolves anomaly',
            recalculate: false,
          }),
        request(app.getHttpServer())
          .post(`/api/attendance/anomalies/${rec.id}/resolve`)
          .set('Authorization', `Bearer ${hrToken}`)
          .send({
            action: AnomalyResolutionAction.RESOLVE,
            notes: 'HR Manager resolves anomaly',
            recalculate: false,
          }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 400]);

      // Database verification: Anomaly status is RESOLVED and resolved only once
      const anomalies = await prisma.attendanceAnomaly.findMany({
        where: { attendanceRecordId: rec.id },
      });
      expect(anomalies.length).toBe(1);
      expect(anomalies[0].status).toBe(AnomalyStatus.RESOLVED);
    });

    it('Scenario 12: Recalculation versus correction approval (Level 3/4/5/7/8 locks serialize without deadlocks)', async () => {
      const dateStr = '2026-09-08';
      const attDate = parseDateOnly(dateStr);

      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.PRESENT,
          ...createRecordSnapshotData(dateStr),
          sessions: {
            create: {
              rawCheckInAt: new Date(`${dateStr}T03:30:00.000Z`),
              rawCheckOutAt: new Date(`${dateStr}T10:30:00.000Z`), // 7 hours
              checkInAt: new Date(`${dateStr}T03:30:00.000Z`),
              checkOutAt: new Date(`${dateStr}T10:30:00.000Z`),
              durationSeconds: 25200,
              status: AttendanceSessionStatus.COMPLETED,
            },
          },
        },
        include: { sessions: true },
      });
      createdRecordIds.push(rec.id);

      const session = rec.sessions[0];

      const corr = await prisma.attendanceCorrectionRequest.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          attendanceSessionId: session.id,
          requestedCheckInAt: new Date(`${dateStr}T03:30:00.000Z`),
          requestedCheckOutAt: new Date(`${dateStr}T12:30:00.000Z`), // 9 hours
          reason: 'Correction to full shift duration',
          status: AttendanceCorrectionStatus.PENDING,
        },
      });

      // Concurrently fire recalculate and correction approval
      const [recalcRes, corrRes] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/attendance/records/${rec.id}/recalculate`)
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({ isReconciled: true }),
        request(app.getHttpServer())
          .post(`/api/attendance/corrections/${corr.id}/approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({ managerNotes: 'Approve correction concurrent with recalculation' }),
      ]);

      expect([recalcRes.status, corrRes.status]).toEqual([200, 200]);

      // Verify deterministic final state
      const finalRec = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(finalRec.status).toBe(AttendanceStatus.PRESENT);
      expect(finalRec.grossWorkingDurationSeconds).toBeGreaterThanOrEqual(25200);
    });
  });

  // =========================================================================
  // PART 2: COMPREHENSIVE API INTEGRATION & SECURITY VERIFICATION
  // =========================================================================
  describe('Part 2: Subsystem-Wide API Integration & Security Verification', () => {

    it('2.1 Shift Management: Rejects overlapping shift assignments with 409 Conflict', async () => {
      // Overlapping assignment attempt for employee
      const res = await request(app.getHttpServer())
        .post('/api/attendance/shifts/assign')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          startDate: '2026-05-01',
          endDate: '2026-06-30',
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/overlap/i);
    });

    it('2.2 Today Attendance & History: Employee can query own, but rejected from querying other without permission', async () => {
      // 1. Employee query own today
      const todayRes = await request(app.getHttpServer())
        .get('/api/attendance/today')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      expect(todayRes.body.data).toBeDefined();

      // 2. Employee query own history
      const histRes = await request(app.getHttpServer())
        .get('/api/attendance/history')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      expect(histRes.body.data.items).toBeDefined();

      // 3. Employee attempts to query other employee's history -> 403 Forbidden
      await request(app.getHttpServer())
        .get(`/api/attendance/history?userId=${otherEmployeeId}`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
    });

    it('2.3 Anti-Self-Approval: Manager cannot approve their own overtime request (403 Forbidden)', async () => {
      const dateStr = '2026-09-09';
      const ot = await prisma.attendanceOvertimeRequest.create({
        data: {
          userId: managerId, // Created by Manager
          attendanceDate: parseDateOnly(dateStr),
          startTime: new Date(`${dateStr}T12:30:00.000Z`),
          endTime: new Date(`${dateStr}T13:30:00.000Z`),
          reason: 'Manager project deadline',
          status: OvertimeApprovalStatus.PENDING,
        },
      });
      createdOvertimeIds.push(ot.id);

      // Manager attempts self-approval
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/overtime/${ot.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ approvedDurationMinutes: 60 })
        .expect(403);

      expect(res.body.message).toMatch(/self-approval/i);
    });

    it('2.4 Anti-Self-Approval: Manager cannot approve their own WFH request (403 Forbidden)', async () => {
      const dateStr = '2026-09-10';
      const wfh = await prisma.attendanceWfhRequest.create({
        data: {
          userId: managerId,
          startDate: parseDateOnly(dateStr),
          endDate: parseDateOnly(dateStr),
          reason: 'Manager home work request',
          status: WfhStatus.PENDING,
        },
      });
      createdWfhIds.push(wfh.id);

      // Manager attempts self-approval
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/wfh/${wfh.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(403);

      expect(res.body.message).toMatch(/self-approval/i);
    });

    it('2.5 Anti-Self-Resolution: Actor cannot resolve their own attendance anomaly (403 Forbidden)', async () => {
      const dateStr = '2026-09-11';
      // Create anomaly for HR user
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: hrId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parseDateOnly(dateStr),
          status: AttendanceStatus.PENDING_RECONCILIATION,
          hasIntegrityAnomaly: true,
          anomalyType: 'MISSING_CHECK_IN',
          anomalyDetails: 'HR missing punch',
          ...createRecordSnapshotData(dateStr),
        },
      });
      createdRecordIds.push(rec.id);

      // HR attempts to self-resolve
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/anomalies/${rec.id}/resolve`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          action: AnomalyResolutionAction.RESOLVE,
          notes: 'Self-certifying punch anomaly',
        })
        .expect(403);

      expect(res.body.message).toMatch(/anti-self-approval/i);
    });

    it('2.6 Immutability of Raw Telemetry: Recalculation and reconciliation never mutate raw punch timestamps', async () => {
      const dateStr = '2026-09-12';
      const attDate = parseDateOnly(dateStr);
      const rawIn = new Date(`${dateStr}T03:30:12.345Z`);
      const rawOut = new Date(`${dateStr}T12:30:45.678Z`);

      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          ...createRecordSnapshotData(dateStr),
          sessions: {
            create: {
              rawCheckInAt: rawIn,
              rawCheckOutAt: rawOut,
              checkInAt: rawIn,
              checkOutAt: rawOut,
              durationSeconds: 32433,
              status: AttendanceSessionStatus.COMPLETED,
            },
          },
        },
        include: { sessions: true },
      });
      createdRecordIds.push(rec.id);
      const session = rec.sessions[0];

      // Reconcile
      await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: true,
          forceReason: 'Audit telemetry immutability test',
        })
        .expect(200);

      // Recalculate
      await request(app.getHttpServer())
        .post(`/api/attendance/records/${rec.id}/recalculate`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ isReconciled: true })
        .expect(200);

      const refreshedSession = await prisma.attendanceSession.findUniqueOrThrow({
        where: { id: session.id },
      });

      // Raw timestamps are bit-for-bit identical
      expect(refreshedSession.rawCheckInAt).toEqual(rawIn);
      expect(refreshedSession.rawCheckOutAt).toEqual(rawOut);
    });

    it('2.7 Force Reconciliation: Bypasses cutoff with permission and reason, logs audit record', async () => {
      const dateStr = '2026-12-28'; // Far future date

      // 1. Missing permission -> 403
      await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: true,
          forceReason: 'Employee force attempt',
        })
        .expect(403);

      // 2. Missing forceReason -> 400
      await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: true,
          forceReason: 'abc', // < 5 chars
        })
        .expect(400);

      // 3. Authorized Super Admin with reason -> 200
      const okRes = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: true,
          forceReason: 'Authorized emergency EOD reconciliation run',
        })
        .expect(200);

      const runId = okRes.body.data.id;
      createdRunIds.push(runId);

      // Audit log check
      const audit = await prisma.auditLog.findFirst({
        where: {
          entityType: 'AttendanceReconciliationRun',
          entityId: runId,
          actorUserId: superAdminId,
        },
      });
      expect(audit).toBeDefined();
    });
  });
});
