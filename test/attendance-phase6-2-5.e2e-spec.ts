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
  WfhStatus,
} from '../src/generated/prisma/enums';
import {
  parseDateOnly,
} from '../src/modules/attendance/attendance.utils';

describe('Phase 6.2.5: Overtime & WFH Request Lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  let superAdminToken: string;
  let superAdminId: string;

  let managerToken: string;
  let managerId: string;

  let employeeToken: string;
  let employeeId: string;

  let otherEmployeeToken: string;
  let otherEmployeeId: string;

  let testShiftId: string;
  const createdRecordIds: string[] = [];
  const createdOvertimeIds: string[] = [];
  const createdWfhIds: string[] = [];
  let createdOtherUserId: string | null = null;

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
        refreshTokenHash: 'e2e_sa_625_' + Date.now(),
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
        refreshTokenHash: 'e2e_emp_625_' + Date.now(),
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

    // 3. Project Manager (has attendance.approve_overtime and attendance.approve_wfh, DEPARTMENT scope)
    const pm = await prisma.user.findFirst({
      where: {
        userType: { code: 'EMPLOYEE' },
        userRoles: { some: { role: { code: 'PROJECT_MANAGER' } } },
        deletedAt: null,
      },
    });
    if (!pm) throw new Error('Project Manager not found');
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
        refreshTokenHash: 'e2e_pm_625_' + Date.now(),
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

    // 4. Second Employee (in different department or isolated)
    let otherEmp = await prisma.user.findFirst({
      where: {
        id: { notIn: [emp.id, pm.id, superAdmin.id] },
        userType: { code: 'EMPLOYEE' },
        deletedAt: null,
      },
    });
    if (!otherEmp) {
      const empType = await prisma.userType.findUniqueOrThrow({ where: { code: 'EMPLOYEE' } });
      const devRole = await prisma.role.findUniqueOrThrow({ where: { code: 'DEVELOPER' } });
      otherEmp = await prisma.user.create({
        data: {
          userCode: 'OTHER_EMP_625',
          name: 'QA Other Employee',
          email: 'qa.other.625@slashcrm.com',
          userTypeId: empType.id,
          userRoles: { create: { roleId: devRole.id } },
        },
      });
      createdOtherUserId = otherEmp.id;
    }
    otherEmployeeId = otherEmp.id;

    // Ensure otherEmp is assigned to a distinct department for DEPARTMENT data scope testing
    const otherDept = await prisma.department.findFirst({
      where: { id: { not: dept?.id } },
    });
    if (dept) {
      await prisma.userDepartment.deleteMany({
        where: { userId: otherEmp.id, departmentId: dept.id },
      });
    }
    if (otherDept) {
      await prisma.userDepartment.upsert({
        where: {
          userId_departmentId: {
            userId: otherEmp.id,
            departmentId: otherDept.id,
          },
        },
        create: {
          userId: otherEmp.id,
          departmentId: otherDept.id,
          isPrimary: true,
        },
        update: {},
      });
    }

    const otherSession = await prisma.userSession.create({
      data: {
        userId: otherEmp.id,
        refreshTokenHash: 'e2e_other_625_' + Date.now(),
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

    // 5. Test Shift Definition
    let shift = await prisma.shiftDefinition.findUnique({
      where: { code: 'TEST_SHIFT_625' },
    });
    if (!shift) {
      shift = await prisma.shiftDefinition.create({
        data: {
          code: 'TEST_SHIFT_625',
          name: 'Phase 6.2.5 Test Shift',
          startTime: '09:00',
          endTime: '18:00',
          isOvernight: false,
          gracePeriodMinutes: 15,
          halfDayThresholdMinutes: 240,
          fullDayThresholdMinutes: 480,
          overtimeThresholdMinutes: 540,
          allowMultipleSessions: true,
          autoCloseGraceMinutes: 30,
          breakPolicySnapshot: JSON.stringify({
            paidAllowanceMinutes: 60,
            breakTypes: [
              { code: 'TEA', name: 'Tea Break', maxDurationMinutes: 15, isPaid: true },
            ],
          }),
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
    if (createdWfhIds.length > 0) {
      await prisma.attendanceWfhRequest.deleteMany({
        where: { id: { in: createdWfhIds } },
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
    if (testShiftId) {
      await prisma.shiftDefinition.deleteMany({
        where: { code: 'TEST_SHIFT_625' },
      });
    }
    if (createdOtherUserId) {
      await prisma.userSession.deleteMany({ where: { userId: createdOtherUserId } });
      await prisma.userRole.deleteMany({ where: { userId: createdOtherUserId } });
      await prisma.user.delete({ where: { id: createdOtherUserId } });
    }
    await app.close();
  });

  // =========================================================================
  // SUITE 1: Overtime Request Lifecycle
  // =========================================================================
  describe('1. Overtime Request Lifecycle', () => {
    let testOtId: string;

    it('1.1 should create a valid overtime request within the daily limit (201 Created)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/overtime')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-05-01',
          startTime: '2026-05-01T18:00:00.000Z',
          endTime: '2026-05-01T20:00:00.000Z', // 120 minutes <= 240 limit
          reason: 'Post-release deployment monitoring',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.status).toBe(OvertimeApprovalStatus.PENDING);
      expect(res.body.data.approvedDurationMinutes).toBe(120);

      testOtId = res.body.data.id;
      createdOvertimeIds.push(testOtId);

      // Verify audit log creation
      const audit = await prisma.auditLog.findFirst({
        where: {
          entityType: 'AttendanceOvertimeRequest',
          entityId: testOtId,
          action: 'CREATE',
        },
      });
      expect(audit).toBeDefined();
    });

    it('1.2 should reject overtime request with invalid start/end order (startTime >= endTime) (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/overtime')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-05-02',
          startTime: '2026-05-02T20:00:00.000Z',
          endTime: '2026-05-02T18:00:00.000Z', // Inverted
          reason: 'Invalid interval test',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('startTime must be strictly before endTime');
    });

    it('1.3 should reject overtime exceeding the daily limit (300m > 240m) without override permission (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/overtime')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-05-03',
          startTime: '2026-05-03T18:00:00.000Z',
          endTime: '2026-05-03T23:00:00.000Z', // 5 hours = 300 minutes > 240
          reason: 'Excessive overtime without override permission',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('exceeds the daily limit of 240 minutes');
      expect(res.body.message).toContain('attendance.override_overtime_limit');
    });

    it('1.3b should reject overtime request when existing pending/approved requests plus new request exceed daily limit (120m + 150m = 270m > 240m) (400 Bad Request)', async () => {
      // testOtId from 1.1 already exists on 2026-05-01 for 120 minutes (18:00-20:00)
      const res = await request(app.getHttpServer())
        .post('/api/attendance/overtime')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-05-01',
          startTime: '2026-05-01T21:00:00.000Z',
          endTime: '2026-05-01T23:30:00.000Z', // 150 minutes, non-overlapping
          reason: 'Second overtime request on same day exceeding daily ceiling',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('exceeds the daily limit of 240 minutes');
    });

    it('1.4 should permit overtime exceeding limit for actor with explicit override permission (Super Admin) (201 Created)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/overtime')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          attendanceDate: '2026-05-04',
          startTime: '2026-05-04T18:00:00.000Z',
          endTime: '2026-05-04T23:00:00.000Z', // 300 minutes
          reason: 'Executive approved extended overtime',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.approvedDurationMinutes).toBe(300);
      createdOvertimeIds.push(res.body.data.id);
    });

    it('1.5 should reject duplicate or overlapping overtime request for the same date and time (409 Conflict)', async () => {
      // Overlaps with testOtId (2026-05-01 18:00-20:00)
      const res = await request(app.getHttpServer())
        .post('/api/attendance/overtime')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-05-01',
          startTime: '2026-05-01T19:00:00.000Z',
          endTime: '2026-05-01T21:00:00.000Z', // Overlaps 19:00-20:00
          reason: 'Conflicting overtime window',
        })
        .expect(409);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('overlapping');
    });

    it('1.6 should allow employee to list their own overtime requests (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/overtime/my-requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      const found = res.body.data.items.find((item: any) => item.id === testOtId);
      expect(found).toBeDefined();
    });

    it('1.7 should forbid standard employee from viewing manager scoped requests (403 Forbidden)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/overtime')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
    });

    it('1.8 should allow authorized manager to view scoped overtime requests (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/overtime')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      const found = res.body.data.items.find((item: any) => item.id === testOtId);
      expect(found).toBeDefined();
    });

    it('1.8b should prevent manager from viewing overtime requests outside their authorized department data scope', async () => {
      // Create an overtime request by otherEmployee (who is not in manager's department)
      const otherOt = await request(app.getHttpServer())
        .post('/api/attendance/overtime')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({
          attendanceDate: '2026-05-09',
          startTime: '2026-05-09T18:00:00.000Z',
          endTime: '2026-05-09T20:00:00.000Z',
          reason: 'Other employee overtime',
        })
        .expect(201);
      createdOvertimeIds.push(otherOt.body.data.id);

      // 1. Direct query with userId filter for otherEmployee must return 403 Forbidden
      const resFilter = await request(app.getHttpServer())
        .get(`/api/attendance/overtime?userId=${otherEmployeeId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
      expect(resFilter.body.message).toContain('not within your department');

      // 2. Unfiltered list by manager must NOT include otherEmployee's request
      const resList = await request(app.getHttpServer())
        .get('/api/attendance/overtime')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      const found = resList.body.data.items.find((item: any) => item.id === otherOt.body.data.id);
      expect(found).toBeUndefined();
    });

    it('1.9 should prevent self-approval of overtime requests (403 Forbidden)', async () => {
      // Create an overtime request by the manager themselves
      const pmOt = await request(app.getHttpServer())
        .post('/api/attendance/overtime')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          attendanceDate: '2026-05-05',
          startTime: '2026-05-05T18:00:00.000Z',
          endTime: '2026-05-05T19:30:00.000Z',
          reason: 'PM self overtime request',
        })
        .expect(201);

      createdOvertimeIds.push(pmOt.body.data.id);

      // Manager attempting to approve their own request
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/overtime/${pmOt.body.data.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Self-approval of overtime requests is strictly prohibited');
    });

    it('1.10 should approve overtime request by authorized manager and trigger recalculation if record exists (200 OK)', async () => {
      // Create an attendance record for employee on 2026-05-01 with actual post-shift work
      const record = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parseDateOnly('2026-05-01'),
          status: AttendanceStatus.PENDING_RECONCILIATION,
          shiftStartTimeSnapshot: new Date('2026-05-01T09:00:00.000Z'),
          shiftEndTimeSnapshot: new Date('2026-05-01T18:00:00.000Z'),
          isOvernightSnapshot: false,
          halfDayThresholdSecondsSnapshot: 14400,
          fullDayThresholdSecondsSnapshot: 28800,
          overtimeThresholdSecondsSnapshot: 32400,
          allowMultipleSessionsSnapshot: true,
          breakPolicySnapshot: JSON.stringify({ paidAllowanceMinutes: 60, breakTypes: [] }),
        },
      });
      createdRecordIds.push(record.id);

      // Session: worked 09:00 to 19:30 (1.5h post-shift work)
      await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: record.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-05-01T09:00:00.000Z'),
          rawCheckOutAt: new Date('2026-05-01T19:30:00.000Z'),
          checkInAt: new Date('2026-05-01T09:00:00.000Z'),
          checkOutAt: new Date('2026-05-01T19:30:00.000Z'),
          durationSeconds: 37800,
          status: 'COMPLETED',
        },
      });

      // Manager approves the overtime request (approved window: 18:00 to 20:00)
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/overtime/${testOtId}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ approvedDurationMinutes: 120 })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(OvertimeApprovalStatus.APPROVED);

      // Verify that deterministic recalculation updated the AttendanceRecord's verifiedOvertimeSeconds
      // Intersection of post-shift work [18:00, 19:30] and approved window [18:00, 20:00] = 5400s (90 mins)
      const updatedRecord = await prisma.attendanceRecord.findUnique({
        where: { id: record.id },
      });
      expect(updatedRecord?.verifiedOvertimeSeconds).toBe(5400);
    });

    it('1.11 should reject re-approving an already approved overtime request (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/overtime/${testOtId}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('is no longer pending');
    });

    it('1.12 should reject an overtime request by manager with reason (200 OK)', async () => {
      const newOt = await request(app.getHttpServer())
        .post('/api/attendance/overtime')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-05-06',
          startTime: '2026-05-06T18:00:00.000Z',
          endTime: '2026-05-06T19:00:00.000Z',
          reason: 'Overtime to be rejected',
        })
        .expect(201);

      createdOvertimeIds.push(newOt.body.data.id);

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/overtime/${newOt.body.data.id}/reject`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ managerNotes: 'Unplanned budget constraint' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(OvertimeApprovalStatus.REJECTED);
    });

    it('1.13 should allow employee to cancel their own pending overtime request (200 OK)', async () => {
      const pendingOt = await request(app.getHttpServer())
        .post('/api/attendance/overtime')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-05-07',
          startTime: '2026-05-07T18:00:00.000Z',
          endTime: '2026-05-07T19:00:00.000Z',
          reason: 'To be cancelled by employee',
        })
        .expect(201);

      createdOvertimeIds.push(pendingOt.body.data.id);

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/overtime/${pendingOt.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(OvertimeApprovalStatus.CANCELLED);
    });

    it('1.14 should disallow employee from cancelling another user’s overtime request (403 Forbidden)', async () => {
      const otherOt = await request(app.getHttpServer())
        .post('/api/attendance/overtime')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({
          attendanceDate: '2026-05-08',
          startTime: '2026-05-08T18:00:00.000Z',
          endTime: '2026-05-08T19:00:00.000Z',
          reason: 'Other employee overtime',
        })
        .expect(201);

      createdOvertimeIds.push(otherOt.body.data.id);

      // Main employee attempts to cancel other employee's request
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/overtime/${otherOt.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('only cancel your own');
    });

    it('1.15 should reflect approved duration override in the approved interval consumed by calculation service', async () => {
      const record = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parseDateOnly('2026-05-22'),
          shiftStartTimeSnapshot: new Date('2026-05-22T03:30:00.000Z'),
          shiftEndTimeSnapshot: new Date('2026-05-22T12:30:00.000Z'), // 18:00 IST
          fullDayThresholdSecondsSnapshot: 8 * 3600,
          halfDayThresholdSecondsSnapshot: 4 * 3600,
          overtimeThresholdSecondsSnapshot: 8 * 3600,
          allowMultipleSessionsSnapshot: false,
          breakPolicySnapshot: JSON.stringify({
            paidAllowanceMinutes: 60,
            autoCloseGraceMinutes: 30,
            breakTypes: [],
          }),
          status: AttendanceStatus.PENDING_RECONCILIATION,
        },
      });
      createdRecordIds.push(record.id);

      await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: record.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-05-22T03:30:00.000Z'),
          checkInAt: new Date('2026-05-22T03:30:00.000Z'),
          rawCheckOutAt: new Date('2026-05-22T14:30:00.000Z'), // 20:00 IST (2h post shift)
          checkOutAt: new Date('2026-05-22T14:30:00.000Z'),
          status: AttendanceSessionStatus.COMPLETED,
          durationSeconds: 11 * 3600,
        },
      });

      const otReq = await request(app.getHttpServer())
        .post('/api/attendance/overtime')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-05-22',
          startTime: '2026-05-22T12:30:00.000Z',
          endTime: '2026-05-22T14:30:00.000Z', // 120m
          reason: 'Post-shift deployment override test',
        })
        .expect(201);
      createdOvertimeIds.push(otReq.body.data.id);

      const approveRes = await request(app.getHttpServer())
        .post(`/api/attendance/overtime/${otReq.body.data.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ approvedDurationMinutes: 60 })
        .expect(200);

      expect(approveRes.body.data.approvedDurationMinutes).toBe(60);
      const updatedRecord = await prisma.attendanceRecord.findUnique({
        where: { id: record.id },
      });
      // Verified overtime should be exactly 3600 seconds (60 mins), NOT 7200 seconds (120 mins)
      expect(updatedRecord?.verifiedOvertimeSeconds).toBe(3600);
    });
  });

  // =========================================================================
  // SUITE 2: WFH Request Lifecycle
  // =========================================================================
  describe('2. WFH Request Lifecycle', () => {
    let testWfhId: string;

    it('2.1 should create a valid WFH request for a date range (201 Created)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/wfh')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          startDate: '2026-05-10',
          endDate: '2026-05-12',
          reason: 'Remote client deliverables support',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.status).toBe(WfhStatus.PENDING);

      testWfhId = res.body.data.id;
      createdWfhIds.push(testWfhId);

      // Verify audit log creation
      const audit = await prisma.auditLog.findFirst({
        where: {
          entityType: 'AttendanceWfhRequest',
          entityId: testWfhId,
          action: 'CREATE',
        },
      });
      expect(audit).toBeDefined();
    });

    it('2.2 should reject WFH request where startDate is after endDate (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/wfh')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          startDate: '2026-05-15',
          endDate: '2026-05-14', // Invalid order
          reason: 'Invalid date range test',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('startDate must be on or before endDate');
    });

    it('2.3 should reject conflicting / overlapping WFH request for the same employee (409 Conflict)', async () => {
      // Overlaps with 2026-05-10 to 2026-05-12
      const res = await request(app.getHttpServer())
        .post('/api/attendance/wfh')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          startDate: '2026-05-11',
          endDate: '2026-05-13',
          reason: 'Overlapping WFH request',
        })
        .expect(409);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('overlapping');
    });

    it('2.4 should allow employee to list their own WFH requests without approval permissions (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/wfh/my-requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      const found = res.body.data.items.find((item: any) => item.id === testWfhId);
      expect(found).toBeDefined();
    });

    it('2.5 should forbid standard employee from viewing manager scoped WFH requests (403 Forbidden)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/wfh')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
    });

    it('2.6 should allow manager to view scoped WFH requests within their data scope (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/wfh')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      const found = res.body.data.items.find((item: any) => item.id === testWfhId);
      expect(found).toBeDefined();
    });

    it('2.6b should prevent manager from viewing WFH requests outside their authorized department data scope', async () => {
      const otherWfh = await request(app.getHttpServer())
        .post('/api/attendance/wfh')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({
          startDate: '2026-05-25',
          endDate: '2026-05-26',
          reason: 'Other employee remote work',
        })
        .expect(201);
      createdWfhIds.push(otherWfh.body.data.id);

      // Direct filter by foreign userId returns 403 Forbidden
      const resFilter = await request(app.getHttpServer())
        .get(`/api/attendance/wfh?userId=${otherEmployeeId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
      expect(resFilter.body.message).toContain('not within your department');

      // Unfiltered list does NOT include foreign department request
      const resList = await request(app.getHttpServer())
        .get('/api/attendance/wfh')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      const found = resList.body.data.items.find((item: any) => item.id === otherWfh.body.data.id);
      expect(found).toBeUndefined();
    });

    it('2.7 should prevent self-approval of WFH requests (403 Forbidden)', async () => {
      const pmWfh = await request(app.getHttpServer())
        .post('/api/attendance/wfh')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          startDate: '2026-05-20',
          endDate: '2026-05-20',
          reason: 'PM WFH self-request',
        })
        .expect(201);

      createdWfhIds.push(pmWfh.body.data.id);

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/wfh/${pmWfh.body.data.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Self-approval of WFH requests is strictly prohibited');
    });

    it('2.8 should approve WFH request and strictly NOT automatically create attendance sessions or mark present (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/wfh/${testWfhId}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(WfhStatus.APPROVED);

      // Verify that NO attendance record or session was automatically created for this date
      const record = await prisma.attendanceRecord.findUnique({
        where: {
          unique_user_daily_attendance: {
            userId: employeeId,
            attendanceDate: parseDateOnly('2026-05-10'),
          },
        },
      });
      expect(record).toBeNull();
    });

    it('2.9 should reject a WFH request with manager reason (200 OK)', async () => {
      const newWfh = await request(app.getHttpServer())
        .post('/api/attendance/wfh')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          startDate: '2026-05-25',
          endDate: '2026-05-26',
          reason: 'To be rejected',
        })
        .expect(201);

      createdWfhIds.push(newWfh.body.data.id);

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/wfh/${newWfh.body.data.id}/reject`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ managerNotes: 'Client onsite requirement' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(WfhStatus.REJECTED);
    });

    it('2.10 should allow employee to cancel their own pending WFH request (200 OK)', async () => {
      const pendingWfh = await request(app.getHttpServer())
        .post('/api/attendance/wfh')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          startDate: '2026-05-28',
          endDate: '2026-05-29',
          reason: 'To be cancelled by employee',
        })
        .expect(201);

      createdWfhIds.push(pendingWfh.body.data.id);

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/wfh/${pendingWfh.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(WfhStatus.CANCELLED);
    });
  });

  // =========================================================================
  // SUITE 3: Real MySQL Concurrency & Serialization Under Level 5/6 Locks
  // =========================================================================
  describe('3. Real MySQL Concurrency & Serialization', () => {
    it('3.1 should handle concurrent overtime approvals cleanly without deadlock (exactly one succeeds)', async () => {
      const ot = await request(app.getHttpServer())
        .post('/api/attendance/overtime')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-05-30',
          startTime: '2026-05-30T18:00:00.000Z',
          endTime: '2026-05-30T20:00:00.000Z',
          reason: 'Concurrent approval test',
        })
        .expect(201);

      const otId = ot.body.data.id;
      createdOvertimeIds.push(otId);

      // Concurrently fire two approvals (Super Admin and Manager)
      const [res1, res2] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/attendance/overtime/${otId}/approve`)
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({}),
        request(app.getHttpServer())
          .post(`/api/attendance/overtime/${otId}/approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({}),
      ]);

      const statuses = [res1.status, res2.status].sort();
      // Exactly one must succeed with 200 OK, the other must be rejected with 400 Bad Request (no longer pending)
      expect(statuses).toEqual([200, 400]);

      const finalState = await prisma.attendanceOvertimeRequest.findUnique({
        where: { id: otId },
      });
      expect(finalState?.status).toBe(OvertimeApprovalStatus.APPROVED);
    });

    it('3.2 should handle concurrent WFH approval and rejection cleanly without conflicting states', async () => {
      const wfh = await request(app.getHttpServer())
        .post('/api/attendance/wfh')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          startDate: '2026-06-01',
          endDate: '2026-06-02',
          reason: 'Concurrent WFH review race test',
        })
        .expect(201);

      const wfhId = wfh.body.data.id;
      createdWfhIds.push(wfhId);

      // Concurrently fire approve and reject
      const [resApprove, resReject] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/attendance/wfh/${wfhId}/approve`)
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({}),
        request(app.getHttpServer())
          .post(`/api/attendance/wfh/${wfhId}/reject`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({}),
      ]);

      const statuses = [resApprove.status, resReject.status].sort();
      // Exactly one succeeds (200), the other gets 400 Bad Request
      expect(statuses).toEqual([200, 400]);

      const finalState = await prisma.attendanceWfhRequest.findUnique({
        where: { id: wfhId },
      });
      expect([WfhStatus.APPROVED, WfhStatus.REJECTED]).toContain(finalState?.status);
    });

    it('3.3 should handle simultaneous overtime request creation that together exceed the 240m daily limit (exactly one succeeds under Level 1 lock)', async () => {
      await prisma.attendanceOvertimeRequest.deleteMany({
        where: { attendanceDate: parseDateOnly('2026-06-05') },
      });

      // Employee attempts two simultaneous requests for the same date (2026-06-05):
      // Request A: 18:00 - 20:30 (150 minutes)
      // Request B: 21:00 - 23:00 (120 minutes)
      // Individually: 150m <= 240m and 120m <= 240m.
      // Combined: 150 + 120 = 270m > 240m.
      // Under Level 1 lock on EmployeeProfile, the requests serialize:
      // Exactly one succeeds (201 Created), and the other fails with 400 Bad Request (exceeds daily ceiling)!
      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/attendance/overtime')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({
            attendanceDate: '2026-06-05',
            startTime: '2026-06-05T18:00:00.000Z',
            endTime: '2026-06-05T20:30:00.000Z', // 150m
            reason: 'Simultaneous request A',
          }),
        request(app.getHttpServer())
          .post('/api/attendance/overtime')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({
            attendanceDate: '2026-06-05',
            startTime: '2026-06-05T21:00:00.000Z',
            endTime: '2026-06-05T23:00:00.000Z', // 120m
            reason: 'Simultaneous request B',
          }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 400]);

      const successRes = resA.status === 201 ? resA : resB;
      const failRes = resA.status === 400 ? resA : resB;

      createdOvertimeIds.push(successRes.body.data.id);
      expect(failRes.body.message).toContain('exceeds the daily limit of 240 minutes');

      // Verify total in database is within the 240m ceiling (only 1 row inserted)
      const createdRequests = await prisma.attendanceOvertimeRequest.findMany({
        where: { userId: employeeId, attendanceDate: parseDateOnly('2026-06-05') },
      });
      expect(createdRequests.length).toBe(1);
    });
  });
});

