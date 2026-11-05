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
  RecordStatus,
} from '../src/generated/prisma/enums';
import { parseDateOnly } from '../src/modules/attendance/attendance.utils';
import { AnomalyResolutionAction } from '../src/modules/attendance/dto/resolve-anomaly.dto';

describe('Phase 6.2.7: EOD Reconciliation & Anomaly Quarantine (e2e)', () => {
  jest.setTimeout(45000);
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
  let overnightShiftId: string;
  const createdRecordIds: string[] = [];
  const createdRunIds: string[] = [];

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
        breakTypes: [],
      }),
    };
  }

  function createOvernightSnapshotData(dateStr: string) {
    const nextDay = new Date(`${dateStr}T00:00:00.000Z`);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDayStr = nextDay.toISOString().split('T')[0];

    return {
      shiftStartTimeSnapshot: new Date(`${dateStr}T14:30:00.000Z`), // 20:00 IST
      shiftEndTimeSnapshot: new Date(`${nextDayStr}T02:30:00.000Z`), // 08:00 IST next day
      isOvernightSnapshot: true,
      halfDayThresholdSecondsSnapshot: 14400,
      fullDayThresholdSecondsSnapshot: 28800,
      overtimeThresholdSecondsSnapshot: 32400,
      allowMultipleSessionsSnapshot: true,
      breakPolicySnapshot: JSON.stringify({
        paidAllowanceMinutes: 60,
        autoCloseGraceMinutes: 30,
        breakTypes: [],
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
        refreshTokenHash: 'e2e_sa_627_' + Date.now(),
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
        refreshTokenHash: 'e2e_emp_627_' + Date.now(),
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

    // 3. Project Manager (has attendance.view_anomalies, DEPARTMENT scope)
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
        refreshTokenHash: 'e2e_pm_627_' + Date.now(),
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

    // 4. HR Manager (has attendance.reconcile, attendance.view_anomalies, attendance.resolve_incident)
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
          email: `e2e_hr_627_${Date.now()}@slash.test`,
          name: 'E2E HR Manager',
          userCode: `HR_${Date.now().toString().slice(-4)}`,
          status: RecordStatus.ACTIVE,
          userTypeId: empType!.id,
          employeeProfile: {
            create: {
              designation: 'HR Specialist',
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
        userId: hrUser.id,
        refreshTokenHash: 'e2e_hr_sess_627_' + Date.now(),
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    hrToken = await jwtService.signAsync(
      {
        sub: hrUser.id,
        email: hrUser.email,
        userCode: hrUser.userCode,
        userType: 'EMPLOYEE',
        roles: ['HR'],
        sessionId: hrSession.id,
      },
      { secret: 'slash@202612354', expiresIn: '15m' },
    );

    // 5. Other Employee (in SALES department, out-of-scope for PM)
    const salesDept = await prisma.department.findFirst({
      where: { code: 'SALES' },
    });
    let otherEmp = await prisma.user.findFirst({
      where: {
        id: { notIn: [emp.id, pm.id, superAdmin.id, hrUser.id] },
        userType: { code: 'EMPLOYEE' },
        deletedAt: null,
      },
      include: { employeeProfile: true },
    });
    if (!otherEmp || !otherEmp.employeeProfile) {
      const empType = await prisma.userType.findFirst({
        where: { code: 'EMPLOYEE' },
      });
      otherEmp = await prisma.user.create({
        data: {
          email: `e2e_other_627_${Date.now()}@slash.test`,
          name: 'E2E Other Sales Employee',
          userCode: `SALES_${Date.now().toString().slice(-4)}`,
          status: RecordStatus.ACTIVE,
          userTypeId: empType!.id,
          employeeProfile: {
            create: {
              designation: 'Sales Rep',
              dateOfJoining: new Date(),
            },
          },
        },
        include: { employeeProfile: true },
      });
    }
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

    const otherSession = await prisma.userSession.create({
      data: {
        userId: otherEmp.id,
        refreshTokenHash: 'e2e_other_sess_627_' + Date.now(),
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
        roles: ['DEVELOPER'],
        sessionId: otherSession.id,
      },
      { secret: 'slash@202612354', expiresIn: '15m' },
    );

    // 6. Test Shifts
    let standardShift = await prisma.shiftDefinition.findFirst({
      where: { code: 'REGULAR_DAY' },
    });
    if (!standardShift) {
      standardShift = await prisma.shiftDefinition.create({
        data: {
          code: 'REGULAR_DAY',
          name: 'Regular Day Shift (09:00 - 18:00)',
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
            breakTypes: [],
          }),
        },
      });
    }
    testShiftId = standardShift.id;

    let nightShift = await prisma.shiftDefinition.findFirst({
      where: { code: 'NIGHT_OVERNIGHT' },
    });
    if (!nightShift) {
      nightShift = await prisma.shiftDefinition.create({
        data: {
          code: 'NIGHT_OVERNIGHT',
          name: 'Night Shift (20:00 - 04:00)',
          startTime: '20:00',
          endTime: '04:00',
          isOvernight: true,
          halfDayThresholdMinutes: 240,
          fullDayThresholdMinutes: 480,
          overtimeThresholdMinutes: 540,
          allowMultipleSessions: true,
          breakPolicySnapshot: JSON.stringify({
            paidAllowanceMinutes: 60,
            autoCloseGraceMinutes: 30,
            breakTypes: [],
          }),
        },
      });
    }
    overnightShiftId = nightShift.id;
  });

  afterAll(async () => {
    // Cleanup records and reconciliation runs created during tests
    if (createdRecordIds.length > 0) {
      await prisma.attendanceAnomaly.deleteMany({
        where: { attendanceRecordId: { in: createdRecordIds } },
      });
      await prisma.attendanceBreak.deleteMany({
        where: { attendanceRecordId: { in: createdRecordIds } },
      });
      await prisma.attendanceCorrectionRequest.deleteMany({
        where: { attendanceRecordId: { in: createdRecordIds } },
      });
      await prisma.attendanceSession.deleteMany({
        where: { attendanceRecordId: { in: createdRecordIds } },
      });
      await prisma.attendanceRecord.deleteMany({
        where: { id: { in: createdRecordIds } },
      });
    }
    if (createdRunIds.length > 0) {
      await prisma.attendanceReconciliationRun.deleteMany({
        where: { id: { in: createdRunIds } },
      });
    }
    await app.close();
  });

  // =========================================================================
  // SUITE 1: EOD RECONCILIATION CORE & CUTOFF ENFORCEMENT
  // =========================================================================
  describe('1. EOD Reconciliation Core & Cutoff Enforcement', () => {
    it('1.1 Normal completed attendance reconciliation marks record PRESENT after cutoff', async () => {
      const dateStr = '2026-08-01';
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
              rawCheckInAt: new Date(`${dateStr}T03:30:00.000Z`), // 09:00 IST
              rawCheckOutAt: new Date(`${dateStr}T12:30:00.000Z`), // 18:00 IST (9h gross)
              checkInAt: new Date(`${dateStr}T03:30:00.000Z`),
              checkOutAt: new Date(`${dateStr}T12:30:00.000Z`),
              durationSeconds: 32400,
              status: AttendanceSessionStatus.COMPLETED,
            },
          },
        },
      });
      createdRecordIds.push(rec.id);

      const res = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ targetDate: dateStr })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('COMPLETED');
      expect(res.body.data.totalReconciled).toBe(1);
      expect(res.body.data.totalQuarantined).toBe(0);
      createdRunIds.push(res.body.data.id);

      // Verify updated record in DB
      const updated = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(updated.status).toBe(AttendanceStatus.PRESENT);
      expect(updated.reconciledAt).not.toBeNull();
      expect(updated.hasIntegrityAnomaly).toBe(false);
      expect(updated.reconciliationRunId).toBe(res.body.data.id);
    });

    it('1.2 Before-cutoff trigger rejection throws 400 Bad Request when grace period has not elapsed', async () => {
      const dateStr = '2026-12-01'; // Far future date
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
              checkInAt: new Date(`${dateStr}T03:30:00.000Z`),
              status: AttendanceSessionStatus.COMPLETED,
            },
          },
        },
      });
      createdRecordIds.push(rec.id);

      const res = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ targetDate: dateStr, forceReconcile: false })
        .expect(400);

      expect(res.body.message).toMatch(/cutoff/i);
    });

    it('1.3 Overnight shift reconciliation accurately computes cross-midnight intervals', async () => {
      const dateStr = '2026-08-02';
      const attDate = parseDateOnly(dateStr);

      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: overnightShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          ...createOvernightSnapshotData(dateStr),
          sessions: {
            create: {
              rawCheckInAt: new Date(`${dateStr}T14:30:00.000Z`), // 20:00 IST
              rawCheckOutAt: new Date(`2026-08-03T02:30:00.000Z`), // 08:00 IST next day (12h gross)
              checkInAt: new Date(`${dateStr}T14:30:00.000Z`),
              checkOutAt: new Date(`2026-08-03T02:30:00.000Z`),
              durationSeconds: 43200,
              status: AttendanceSessionStatus.COMPLETED,
            },
          },
        },
      });
      createdRecordIds.push(rec.id);

      const res = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ targetDate: dateStr })
        .expect(200);

      expect(res.body.data.totalReconciled).toBe(1);
      createdRunIds.push(res.body.data.id);

      const updated = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(updated.status).toBe(AttendanceStatus.PRESENT);
      expect(updated.netWorkingDurationSeconds).toBe(43200);
      expect(updated.hasIntegrityAnomaly).toBe(false);
    });

    it('1.4 Historical snapshot usage evaluates status from immutable snapshot, not current shift table', async () => {
      const dateStr = '2026-08-03';
      const attDate = parseDateOnly(dateStr);

      // Create record with custom 5-hour snapshot (18000s)
      const customSnapshots = {
        ...createRecordSnapshotData(dateStr),
        halfDayThresholdSecondsSnapshot: 9000,
        fullDayThresholdSecondsSnapshot: 18000,
      };

      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          ...customSnapshots,
          sessions: {
            create: {
              rawCheckInAt: new Date(`${dateStr}T03:30:00.000Z`),
              rawCheckOutAt: new Date(`${dateStr}T09:00:00.000Z`), // 5.5 hours = 19800s
              checkInAt: new Date(`${dateStr}T03:30:00.000Z`),
              checkOutAt: new Date(`${dateStr}T09:00:00.000Z`),
              durationSeconds: 19800,
              status: AttendanceSessionStatus.COMPLETED,
            },
          },
        },
      });
      createdRecordIds.push(rec.id);

      const res = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ targetDate: dateStr })
        .expect(200);

      expect(res.body.data.totalReconciled).toBe(1);
      createdRunIds.push(res.body.data.id);

      const updated = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      // 19800 >= 18000 (snapshot threshold) -> PRESENT (even though normal shift threshold is 28800s)
      expect(updated.status).toBe(AttendanceStatus.PRESENT);
      expect(updated.netWorkingDurationSeconds).toBe(19800);
    });
  });

  // =========================================================================
  // SUITE 2: ANOMALY IDENTIFICATION & QUARANTINE
  // =========================================================================
  describe('2. Anomaly Identification & Quarantine', () => {
    it('2.1 Missing check-in quarantines record with MISSING_CHECK_IN anomaly', async () => {
      const dateStr = '2026-08-04';
      const attDate = parseDateOnly(dateStr);

      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          ...createRecordSnapshotData(dateStr),
          // 0 sessions created
        },
      });
      createdRecordIds.push(rec.id);

      const res = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ targetDate: dateStr })
        .expect(200);

      expect(res.body.data.totalQuarantined).toBe(1);
      createdRunIds.push(res.body.data.id);

      const updated = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(updated.hasIntegrityAnomaly).toBe(true);
      expect(updated.anomalyType).toBe('MISSING_CHECK_IN');
      expect(updated.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);
      expect(updated.anomalyDetectedAt).not.toBeNull();
    });

    it('2.2 Missing check-out quarantines record with MISSING_CHECK_OUT anomaly', async () => {
      const dateStr = '2026-08-05';
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
              rawCheckOutAt: null,
              checkInAt: new Date(`${dateStr}T03:30:00.000Z`),
              checkOutAt: null,
              status: AttendanceSessionStatus.COMPLETED, // marked complete without checkOut timestamp
            },
          },
        },
      });
      createdRecordIds.push(rec.id);

      const res = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ targetDate: dateStr })
        .expect(200);

      expect(res.body.data.totalQuarantined).toBe(1);
      createdRunIds.push(res.body.data.id);

      const updated = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(updated.hasIntegrityAnomaly).toBe(true);
      expect(updated.anomalyType).toBe('MISSING_CHECK_OUT');
      expect(updated.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);
    });

    it('2.3 Open session past cutoff quarantines record and marks session QUARANTINED', async () => {
      const dateStr = '2026-08-06';
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
              status: AttendanceSessionStatus.ACTIVE,
            },
          },
        },
      });
      createdRecordIds.push(rec.id);

      const res = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ targetDate: dateStr })
        .expect(200);

      expect(res.body.data.totalQuarantined).toBe(1);
      createdRunIds.push(res.body.data.id);

      const updated = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
        include: { sessions: true },
      });
      expect(updated.hasIntegrityAnomaly).toBe(true);
      expect(updated.anomalyType).toBe('OPEN_SESSION');
      expect(updated.sessions[0].status).toBe(AttendanceSessionStatus.QUARANTINED);
    });

    it('2.4 Open break past cutoff quarantines record and auto-ends break to release lock', async () => {
      const dateStr = '2026-08-07';
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
          breaks: {
            create: {
              breakTypeId: 'LUNCH',
              startedAt: new Date(`${dateStr}T06:00:00.000Z`),
              endedAt: null, // Open break!
            },
          },
        },
      });
      createdRecordIds.push(rec.id);

      const res = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ targetDate: dateStr })
        .expect(200);

      expect(res.body.data.totalQuarantined).toBe(1);
      createdRunIds.push(res.body.data.id);

      const updated = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
        include: { breaks: true },
      });
      expect(updated.hasIntegrityAnomaly).toBe(true);
      expect(updated.anomalyType).toBe('OPEN_BREAK');
      expect(updated.breaks[0].endedAt).not.toBeNull();
      expect(updated.breaks[0].paidDurationSeconds).toBe(0);
    });
  });

  // =========================================================================
  // SUITE 3: IDEMPOTENCY & CONCURRENCY SAFEGUARDS
  // =========================================================================
  describe('3. Idempotency & Concurrency Safeguards', () => {
    it('3.1 Duplicate reconciliation re-run is fully idempotent', async () => {
      const dateStr = '2026-08-01'; // already reconciled in 1.1

      const res = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ targetDate: dateStr })
        .expect(200);

      expect(res.body.data.totalReconciled).toBe(1);
      expect(res.body.data.totalErrors).toBe(0);
      createdRunIds.push(res.body.data.id);

      const record = await prisma.attendanceRecord.findFirst({
        where: { attendanceDate: parseDateOnly(dateStr), userId: employeeId },
      });
      expect(record?.status).toBe(AttendanceStatus.PRESENT);
    });

    it('3.2 Concurrent reconciliation runs on same date serialize cleanly without deadlocks', async () => {
      const dateStr = '2026-08-08';
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

      const [res1, res2] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/attendance/reconciliation/run')
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({ targetDate: dateStr }),
        request(app.getHttpServer())
          .post('/api/attendance/reconciliation/run')
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({ targetDate: dateStr }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      if (res1.body.data?.id) createdRunIds.push(res1.body.data.id);
      if (res2.body.data?.id) createdRunIds.push(res2.body.data.id);

      const updated = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(updated.status).toBe(AttendanceStatus.PRESENT);
      expect(updated.hasIntegrityAnomaly).toBe(false);
    });

    it('3.3 Reconciliation versus correction approval serialize safely under Level 3 locks', async () => {
      const dateStr = '2026-08-09';
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
              rawCheckOutAt: new Date(`${dateStr}T10:30:00.000Z`), // 7h (HALF_DAY)
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

      // Create a pending correction request
      const corr = await prisma.attendanceCorrectionRequest.create({
        data: {
          attendanceRecordId: rec.id,
          attendanceSessionId: rec.sessions[0].id,
          userId: employeeId,
          requestedCheckOutAt: new Date(`${dateStr}T12:30:00.000Z`), // 9h
          reason: 'Forgot to punch out at scheduled time',
          status: AttendanceCorrectionStatus.PENDING,
        },
      });

      // Fire reconciliation and correction approval concurrently
      const [reconRes, approvalRes] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/attendance/reconciliation/run')
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({ targetDate: dateStr }),
        request(app.getHttpServer())
          .post(`/api/attendance/corrections/${corr.id}/approve`)
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({ managerNotes: 'Verified with security log' }),
      ]);

      expect(reconRes.status).toBe(200);
      expect(approvalRes.status).toBe(200);
      if (reconRes.body.data?.id) createdRunIds.push(reconRes.body.data.id);

      const finalRec = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      // Since correction approved 9h work, final status is PRESENT
      expect(finalRec.status).toBe(AttendanceStatus.PRESENT);
      expect(finalRec.hasIntegrityAnomaly).toBe(false);
    });

    it('3.4 Reconciliation versus checkout concurrency serializes safely under Level 3 locks', async () => {
      const dateStr = '2026-08-10';
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
              checkInAt: new Date(`${dateStr}T03:30:00.000Z`),
              status: AttendanceSessionStatus.ACTIVE,
            },
          },
        },
      });
      createdRecordIds.push(rec.id);

      // Concurrent reconciliation (with force) and checkout
      const [reconRes, checkoutRes] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/attendance/reconciliation/run')
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({
            targetDate: dateStr,
            forceReconcile: true,
            forceReason: 'Concurrent test emergency reconciliation override',
          }),
        request(app.getHttpServer())
          .post('/api/attendance/check-out')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({ notes: 'Punch out at day end' }),
      ]);

      // Either checkout completes first (200) and reconciliation reconciles it,
      // or reconciliation quarantines first (200) and checkout receives 400 (session no longer active).
      // Both outcomes are correct and demonstrate ACID lock serialization without crashing.
      expect([200, 400]).toContain(checkoutRes.status);
      expect(reconRes.status).toBe(200);
      if (reconRes.body.data?.id) createdRunIds.push(reconRes.body.data.id);
    });
  });

  // =========================================================================
  // SUITE 4: QUERYING, PERMISSIONS & DATA SCOPES
  // =========================================================================
  describe('4. Querying, Permissions & Data Scopes', () => {
    it('4.1 Listing reconciliation runs succeeds for HR/Admin but denies unauthorized employee with 403', async () => {
      const adminRes = await request(app.getHttpServer())
        .get('/api/attendance/reconciliation/runs')
        .set('Authorization', `Bearer ${hrToken}`)
        .expect(200);

      expect(adminRes.body.success).toBe(true);
      expect(Array.isArray(adminRes.body.data.items)).toBe(true);

      const empRes = await request(app.getHttpServer())
        .get('/api/attendance/reconciliation/runs')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);

      expect(empRes.body.message).toMatch(/Insufficient permissions|Forbidden/i);
    });

    it('4.2 Viewing run details returns complete record summary or 404', async () => {
      if (createdRunIds.length === 0) return;
      const validRunId = createdRunIds[0];

      const res = await request(app.getHttpServer())
        .get(`/api/attendance/reconciliation/runs/${validRunId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.data.id).toBe(validRunId);
      expect(Array.isArray(res.body.data.records)).toBe(true);

      await request(app.getHttpServer())
        .get('/api/attendance/reconciliation/runs/non_existent_run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(404);
    });

    it('4.3 Viewing reconciliation status for employee/date allows own access but rejects other employees', async () => {
      // Employee viewing own status
      const ownRes = await request(app.getHttpServer())
        .get(`/api/attendance/reconciliation/status?userId=${employeeId}&date=2026-08-01`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      expect(ownRes.body.data.userId).toBe(employeeId);
      expect(ownRes.body.data.isReconciled).toBe(true);

      // Employee attempting to view other employee's status without supervisor permission -> 403
      const forbiddenRes = await request(app.getHttpServer())
        .get(`/api/attendance/reconciliation/status?userId=${otherEmployeeId}&date=2026-08-01`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);

      expect(forbiddenRes.body.message).toMatch(/denied/i);
    });

    it('4.4 Listing quarantined anomalies enforces manager department data scope', async () => {
      // Create quarantined anomaly for other employee in SALES dept
      const dateStr = '2026-08-15';
      const salesRec = await prisma.attendanceRecord.create({
        data: {
          userId: otherEmployeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parseDateOnly(dateStr),
          status: AttendanceStatus.PENDING_RECONCILIATION,
          hasIntegrityAnomaly: true,
          anomalyType: 'MISSING_CHECK_IN',
          anomalyDetails: 'Sales employee missing check-in',
          ...createRecordSnapshotData(dateStr),
        },
      });
      createdRecordIds.push(salesRec.id);

      // Manager (in DEVELOPMENT dept) queries anomalies
      const pmRes = await request(app.getHttpServer())
        .get('/api/attendance/anomalies')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);

      const items = pmRes.body.data.items;
      // PM should NOT see the sales employee's record
      const hasSalesAnomaly = items.some((item: any) => item.userId === otherEmployeeId);
      expect(hasSalesAnomaly).toBe(false);

      // Super Admin (ALL scope) CAN see both
      const saRes = await request(app.getHttpServer())
        .get('/api/attendance/anomalies')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      const saHasSales = saRes.body.data.items.some((item: any) => item.userId === otherEmployeeId);
      expect(saHasSales).toBe(true);
    });

    it('4.5 Viewing individual anomaly details respects supervisor scope', async () => {
      const salesRecId = createdRecordIds[createdRecordIds.length - 1];

      // PM attempting to view sales employee's anomaly -> 403 Forbidden
      await request(app.getHttpServer())
        .get(`/api/attendance/anomalies/${salesRecId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);

      // Super Admin viewing same anomaly -> 200 OK
      const res = await request(app.getHttpServer())
        .get(`/api/attendance/anomalies/${salesRecId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.data.id).toBe(salesRecId);
      expect(res.body.data.hasIntegrityAnomaly).toBe(true);
    });
  });

  // =========================================================================
  // SUITE 5: ANOMALY RESOLUTION & DISPUTE WORKFLOW
  // =========================================================================
  describe('5. Anomaly Resolution & Dispute Workflow', () => {
    it('5.1 Authorized anomaly resolution clears anomaly flags and logs audit trail', async () => {
      const dateStr = '2026-08-16';
      const attDate = parseDateOnly(dateStr);

      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          hasIntegrityAnomaly: true,
          anomalyType: 'OVERLAPPING_SESSIONS',
          anomalyDetails: 'Detected session collision',
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

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/anomalies/${rec.id}/resolve`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          action: AnomalyResolutionAction.RESOLVE,
          notes: 'Supervisor verified physical register and resolved discrepancy',
          recalculate: true,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.hasIntegrityAnomaly).toBe(false);
      expect(res.body.data.anomalyResolvedAt).not.toBeNull();
      expect(res.body.data.anomalyResolvedByUserId).toBe(superAdminId);
      expect(res.body.data.anomalyResolutionNotes).toContain('physical register');

      // Verify recalculated status in DB
      const updated = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(updated.hasIntegrityAnomaly).toBe(false);
      expect(updated.status).toBe(AttendanceStatus.PRESENT);
    });

    it('5.2 Authorized anomaly dismissal marks record ABSENT and clears anomaly flags', async () => {
      const dateStr = '2026-08-17';
      const attDate = parseDateOnly(dateStr);

      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          hasIntegrityAnomaly: true,
          anomalyType: 'MISSING_CHECK_IN',
          anomalyDetails: 'Unverified absence',
          ...createRecordSnapshotData(dateStr),
        },
      });
      createdRecordIds.push(rec.id);

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/anomalies/${rec.id}/resolve`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          action: AnomalyResolutionAction.DISMISS,
          notes: 'Confirmed unauthorized absence with department manager',
        })
        .expect(200);

      expect(res.body.data.hasIntegrityAnomaly).toBe(false);
      expect(res.body.data.status).toBe(AttendanceStatus.ABSENT);
    });

    it('5.3 Unauthorized anomaly resolution is rejected with 403 Forbidden', async () => {
      const recId = createdRecordIds[0];

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/anomalies/${recId}/resolve`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          action: AnomalyResolutionAction.RESOLVE,
          notes: 'Employee self-resolving anomaly',
        })
        .expect(403);

      expect(res.body.message).toMatch(/Insufficient permissions|Forbidden/i);
    });

    it('5.4 Anti-self-resolution prevents manager from resolving their own attendance anomaly', async () => {
      const dateStr = '2026-08-18';
      const attDate = parseDateOnly(dateStr);

      // Create anomaly for HR manager themselves
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: hrId,
          shiftDefinitionId: testShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          hasIntegrityAnomaly: true,
          anomalyType: 'OPEN_SESSION',
          anomalyDetails: 'HR self session',
          ...createRecordSnapshotData(dateStr),
        },
      });
      createdRecordIds.push(rec.id);

      // HR manager attempting to resolve their own anomaly -> 403 Anti-Self-Resolution violation
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/anomalies/${rec.id}/resolve`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          action: AnomalyResolutionAction.RESOLVE,
          notes: 'Self-certifying punch discrepancy',
        })
        .expect(403);

      expect(res.body.message).toMatch(/Anti-self-approval violation/i);
    });

    it('5.5 Mandatory resolution notes validation rejects missing or short notes (<5 chars)', async () => {
      const recId = createdRecordIds[createdRecordIds.length - 1];

      await request(app.getHttpServer())
        .post(`/api/attendance/anomalies/${recId}/resolve`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          action: AnomalyResolutionAction.RESOLVE,
          notes: 'abc', // < 5 chars
        })
        .expect(400);
    });
  });

  // =========================================================================
  // SUITE 6: TARGETED AUDIT: PERSISTENCE, SYSTEM CLOSURE & FORCE AUTH
  // =========================================================================
  describe('6. Targeted Audit: Persistence, System Closure & Force Auth', () => {
    it('6.1 Multi-Anomaly Persistence: Multiple simultaneous anomalies persist individual AttendanceAnomaly records', async () => {
      const dateStr = '2026-08-20';
      const attDate = parseDateOnly(dateStr);

      // Create record with:
      // 1 active session (not checked out) -> triggers OPEN_SESSION
      // 1 open break (endedAt: null) -> triggers OPEN_BREAK
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
              checkInAt: new Date(`${dateStr}T03:30:00.000Z`),
              status: AttendanceSessionStatus.ACTIVE,
            },
          },
          breaks: {
            create: {
              breakTypeId: 'LUNCH',
              startedAt: new Date(`${dateStr}T07:00:00.000Z`),
              endedAt: null,
            },
          },
        },
      });
      createdRecordIds.push(rec.id);

      // Reconcile
      const runRes = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: true,
          forceReason: 'Audit multi-anomaly test verification',
        })
        .expect(200);

      if (runRes.body.data?.id) createdRunIds.push(runRes.body.data.id);

      // 1. Check parent record
      const updatedRec = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(updatedRec.hasIntegrityAnomaly).toBe(true);
      expect(updatedRec.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);
      expect(updatedRec.anomalyDetails).toContain('OPEN_SESSION');
      expect(updatedRec.anomalyDetails).toContain('OPEN_BREAK');

      // 2. Check individual persistent AttendanceAnomaly rows in attendance_anomalies
      const persistedAnomalies = await prisma.attendanceAnomaly.findMany({
        where: { attendanceRecordId: rec.id },
        orderBy: { anomalyType: 'asc' },
      });

      expect(persistedAnomalies.length).toBe(2);
      const types = persistedAnomalies.map((a) => a.anomalyType);
      expect(types).toContain('OPEN_SESSION');
      expect(types).toContain('OPEN_BREAK');
      for (const a of persistedAnomalies) {
        expect(a.status).toBe(AnomalyStatus.ACTIVE);
        expect(a.detectedAt).toBeDefined();
        expect(a.details).toBeTruthy();
      }
    });

    it('6.2 Anomaly Traceability: Resolution preserves historical anomaly classification and sets resolved status', async () => {
      const dateStr = '2026-08-20';
      const rec = await prisma.attendanceRecord.findFirstOrThrow({
        where: { userId: employeeId, attendanceDate: parseDateOnly(dateStr) },
      });

      // Resolve the anomaly
      const resolveRes = await request(app.getHttpServer())
        .post(`/api/attendance/anomalies/${rec.id}/resolve`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          action: AnomalyResolutionAction.RESOLVE,
          notes: 'HR verified employee submitted paper punch slip',
          recalculate: false,
        })
        .expect(200);

      expect(resolveRes.body.data.hasIntegrityAnomaly).toBe(false);

      // Verify persistent anomaly rows in database are NOT deleted, but updated to RESOLVED
      const historicalAnomalies = await prisma.attendanceAnomaly.findMany({
        where: { attendanceRecordId: rec.id },
      });

      expect(historicalAnomalies.length).toBe(2);
      for (const a of historicalAnomalies) {
        expect(a.status).toBe(AnomalyStatus.RESOLVED);
        expect(a.resolvedAt).toBeDefined();
        expect(a.resolvedByUserId).toBe(superAdminId);
        expect(a.resolutionNotes).toBe('HR verified employee submitted paper punch slip');
        // Crucial: original anomaly classification is preserved!
        expect(['OPEN_SESSION', 'OPEN_BREAK']).toContain(a.anomalyType);
      }
    });

    it('6.3 Idempotency: Rerunning reconciliation on anomalous record does not duplicate active anomalies', async () => {
      const dateStr = '2026-08-21';
      const attDate = parseDateOnly(dateStr);

      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          ...createRecordSnapshotData(dateStr),
          // No sessions -> MISSING_CHECK_IN
        },
      });
      createdRecordIds.push(rec.id);

      // First run
      const run1 = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: true,
          forceReason: 'Audit idempotency test run 1',
        })
        .expect(200);
      if (run1.body.data?.id) createdRunIds.push(run1.body.data.id);

      const anomaliesRun1 = await prisma.attendanceAnomaly.findMany({
        where: { attendanceRecordId: rec.id },
      });
      expect(anomaliesRun1.length).toBe(1);
      expect(anomaliesRun1[0].anomalyType).toBe('MISSING_CHECK_IN');

      // Second run (rerun)
      const run2 = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: true,
          forceReason: 'Audit idempotency test run 2 rerun',
        })
        .expect(200);
      if (run2.body.data?.id) createdRunIds.push(run2.body.data.id);

      const anomaliesRun2 = await prisma.attendanceAnomaly.findMany({
        where: { attendanceRecordId: rec.id },
      });
      // MUST NOT create duplicate anomaly rows!
      expect(anomaliesRun2.length).toBe(1);
      expect(anomaliesRun2[0].id).toBe(anomaliesRun1[0].id);
      expect(anomaliesRun2[0].status).toBe(AnomalyStatus.ACTIVE);
    });

    it('6.4 System-Generated Break Closure: Technical closure marks isSystemClosed=true, rawEndedAt=null, zero duration, and calculation continues to flag anomaly', async () => {
      const dateStr = '2026-08-22';
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
              checkInAt: new Date(`${dateStr}T03:30:00.000Z`),
              rawCheckOutAt: new Date(`${dateStr}T12:30:00.000Z`),
              checkOutAt: new Date(`${dateStr}T12:30:00.000Z`),
              durationSeconds: 32400,
              status: AttendanceSessionStatus.COMPLETED,
            },
          },
          breaks: {
            create: {
              breakTypeId: 'TEA',
              startedAt: new Date(`${dateStr}T06:00:00.000Z`),
              endedAt: null, // open break
            },
          },
        },
      });
      createdRecordIds.push(rec.id);

      // Reconcile
      await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: true,
          forceReason: 'Audit system-generated break closure test',
        })
        .expect(200);

      // Inspect persisted break
      const breakRec = await prisma.attendanceBreak.findFirstOrThrow({
        where: { attendanceRecordId: rec.id },
      });

      expect(breakRec.isSystemClosed).toBe(true);
      expect(breakRec.systemClosureReason).toBe('EOD_RECONCILIATION_AUTO_CLOSE');
      expect(breakRec.rawEndedAt).toBeNull(); // telemetry preserved: no fake punch!
      expect(breakRec.endedAt).toEqual(breakRec.startedAt); // technical closure
      expect(breakRec.paidDurationSeconds).toBe(0); // zero unverified duration
      expect(breakRec.unpaidDurationSeconds).toBe(0);

      // Calculation engine verifies this record has integrity anomaly because of system closure
      const updatedRec = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(updatedRec.hasIntegrityAnomaly).toBe(true);
      expect(updatedRec.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);
    });

    it('6.5 System-Generated Session Quarantine: Open session quarantine marks status=QUARANTINED, isSystemClosed=true, rawCheckOutAt=null, durationSeconds=0', async () => {
      const dateStr = '2026-08-23';
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
              checkInAt: new Date(`${dateStr}T03:30:00.000Z`),
              status: AttendanceSessionStatus.ACTIVE, // open active session
            },
          },
        },
      });
      createdRecordIds.push(rec.id);

      await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: true,
          forceReason: 'Audit system-generated session quarantine test',
        })
        .expect(200);

      // Inspect session
      const sessionRec = await prisma.attendanceSession.findFirstOrThrow({
        where: { attendanceRecordId: rec.id },
      });

      expect(sessionRec.status).toBe(AttendanceSessionStatus.QUARANTINED);
      expect(sessionRec.isSystemClosed).toBe(true);
      expect(sessionRec.systemClosureReason).toBe('EOD_RECONCILIATION_QUARANTINE');
      expect(sessionRec.rawCheckOutAt).toBeNull(); // never fabricated
      expect(sessionRec.checkOutAt).toBeNull();
      expect(sessionRec.durationSeconds).toBe(0);

      // Parent record must NOT be marked PRESENT
      const updatedRec = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(updatedRec.status).not.toBe(AttendanceStatus.PRESENT);
      expect(updatedRec.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);
      expect(updatedRec.hasIntegrityAnomaly).toBe(true);
    });

    it('6.6 Force Reconciliation Authorization: Unauthorized employee and manager without permission receive 403 Forbidden', async () => {
      const dateStr = '2026-08-24';

      // 1. Employee lacks attendance.reconcile -> 403
      await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: true,
          forceReason: 'Unauthorized employee force attempt',
        })
        .expect(403);

      // 2. HR manager has attendance.reconcile, but lacks attendance.force_reconcile -> 403
      const hrRes = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${hrToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: true,
          forceReason: 'HR manager without force_reconcile attempt',
        })
        .expect(403);

      expect(hrRes.body.message).toMatch(/attendance\.force_reconcile/i);
    });

    it('6.7 Force Reconciliation Validation: Missing or short forceReason (<5 chars) returns 400 Bad Request', async () => {
      const dateStr = '2026-08-24';

      // 1. Missing forceReason
      const res1 = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: true,
        })
        .expect(400);

      expect(res1.body.message).toMatch(/forceReason is required and must be at least 5 characters/i);

      // 2. Short forceReason (< 5 chars)
      const res2 = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: true,
          forceReason: 'tiny',
        })
        .expect(400);

      expect(res2.body.message).toMatch(/forceReason is required and must be at least 5 characters/i);
    });

    it('6.8 Authorized Force Reconciliation: Bypasses cutoff, enforces all integrity checks, and logs execution audit record', async () => {
      const dateStr = '2026-12-25';
      const attDate = parseDateOnly(dateStr);

      // Future shift cutoff (hours ahead of server time)
      const futureRecord = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: attDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          shiftStartTimeSnapshot: new Date('2026-12-25T03:30:00.000Z'),
          shiftEndTimeSnapshot: new Date('2026-12-25T12:30:00.000Z'), // Far in future from server time
          halfDayThresholdSecondsSnapshot: 14400,
          fullDayThresholdSecondsSnapshot: 28800,
          overtimeThresholdSecondsSnapshot: 32400,
          allowMultipleSessionsSnapshot: true,
          breakPolicySnapshot: JSON.stringify({
            paidAllowanceMinutes: 60,
            autoCloseGraceMinutes: 30,
            breakTypes: [],
          }),
        },
      });
      createdRecordIds.push(futureRecord.id);

      // Reconciling without force throws 400 Bad Request (before cutoff)
      await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: false,
        })
        .expect(400);

      // Authorized SuperAdmin force reconciliation succeeds
      const forceRes = await request(app.getHttpServer())
        .post('/api/attendance/reconciliation/run')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          targetDate: dateStr,
          forceReconcile: true,
          forceReason: 'Executive authorized payroll run cutoff override',
        })
        .expect(200);

      const runId = forceRes.body.data.id;
      createdRunIds.push(runId);

      // Verify Audit record was logged
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          entityType: 'AttendanceReconciliationRun',
          entityId: runId,
          actorUserId: superAdminId,
        },
      });

      expect(auditLog).toBeDefined();
      expect(auditLog?.action).toBe('CREATE');
      const newVals =
        typeof auditLog?.newValues === 'string'
          ? JSON.parse(auditLog.newValues)
          : auditLog?.newValues;
      expect(newVals.forceReconcile).toBe(true);
      expect(newVals.forceReason).toBe('Executive authorized payroll run cutoff override');
      expect(newVals.targetDate).toBe(dateStr);

      // Verify forced reconciliation STILL executed integrity checks: missing check-in quarantined
      const postRec = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: futureRecord.id },
      });
      expect(postRec.hasIntegrityAnomaly).toBe(true);
      expect(postRec.anomalyType).toBe('MISSING_CHECK_IN');
      expect(postRec.status).toBe(AttendanceStatus.PENDING_RECONCILIATION);
    });
  });
});
