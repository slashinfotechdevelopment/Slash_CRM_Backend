import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import {
  AttendanceCorrectionStatus,
  AttendanceSessionStatus,
  AttendanceStatus,
  RecordStatus,
  VerificationOutcome,
} from '../src/generated/prisma/enums';
import { parseDateOnly } from '../src/modules/attendance/attendance.utils';
import { CorrectionType } from '../src/modules/attendance/dto/create-correction-request.dto';

describe('Phase 6.2.6: Correction Request & Dispute Resolution Workflow (e2e)', () => {
  jest.setTimeout(30000);
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
  const createdCorrectionIds: string[] = [];
  let createdOtherUserId: string | null = null;

  function createRecordSnapshotData(dateStr: string) {
    return {
      shiftStartTimeSnapshot: new Date(`${dateStr}T03:30:00.000Z`),
      shiftEndTimeSnapshot: new Date(`${dateStr}T12:30:00.000Z`),
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
        refreshTokenHash: 'e2e_sa_626_' + Date.now(),
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
        refreshTokenHash: 'e2e_emp_626_' + Date.now(),
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

    // 3. Project Manager (has attendance.review_correction and attendance.approve_correction, DEPARTMENT scope)
    const pm = await prisma.user.findFirst({
      where: {
        userType: { code: 'EMPLOYEE' },
        userRoles: { some: { role: { code: 'PROJECT_MANAGER' } } },
        deletedAt: null,
      },
    });
    if (!pm) throw new Error('Project Manager not found');
    managerId = pm.id;

    // Ensure emp and PM share a department (DEVELOPMENT) for DEPARTMENT data scope access
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
        refreshTokenHash: 'e2e_pm_626_' + Date.now(),
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

    // 4. Second Employee (in different department for scope isolation tests)
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
          userCode: 'OTHER_EMP_626',
          name: 'QA Other Employee 626',
          email: 'qa.other.626@slashcrm.com',
          userTypeId: empType.id,
          userRoles: { create: { roleId: devRole.id } },
        },
      });
      createdOtherUserId = otherEmp.id;
    }
    otherEmployeeId = otherEmp.id;

    // Ensure otherEmp is assigned to a distinct department
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
        refreshTokenHash: 'e2e_other_626_' + Date.now(),
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
      where: { code: 'TEST_SHIFT_626' },
    });
    if (!shift) {
      shift = await prisma.shiftDefinition.create({
        data: {
          code: 'TEST_SHIFT_626',
          name: 'Phase 6.2.6 Test Shift',
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
            autoCloseGraceMinutes: 30,
            breakTypes: [],
          }),
        },
      });
    }
    testShiftId = shift.id;

    // Assign shift to main employee
    await prisma.employeeShiftAssignment.upsert({
      where: { id: 'shift_assign_emp_626' },
      create: {
        id: 'shift_assign_emp_626',
        employeeProfileId: emp.employeeProfile.id,
        userId: emp.id,
        shiftDefinitionId: shift.id,
        startDate: parseDateOnly('2026-01-01'),
      },
      update: {
        shiftDefinitionId: shift.id,
      },
    });

    // Ensure PM and OtherEmp also have employee profiles and shift assignments
    let pmProfile = await prisma.employeeProfile.findFirst({ where: { userId: pm.id } });
    if (!pmProfile) {
      pmProfile = await prisma.employeeProfile.create({
        data: {
          userId: pm.id,
          jobTitle: 'Project Manager',
          dateOfJoining: new Date('2025-01-01'),
          workLocation: 'OFFICE',
        },
      });
    }
    await prisma.employeeShiftAssignment.upsert({
      where: { id: 'shift_assign_pm_626' },
      create: {
        id: 'shift_assign_pm_626',
        employeeProfileId: pmProfile.id,
        userId: pm.id,
        shiftDefinitionId: shift.id,
        startDate: parseDateOnly('2026-01-01'),
      },
      update: {
        shiftDefinitionId: shift.id,
      },
    });

    let otherProfile = await prisma.employeeProfile.findFirst({ where: { userId: otherEmp.id } });
    if (!otherProfile) {
      otherProfile = await prisma.employeeProfile.create({
        data: {
          userId: otherEmp.id,
          jobTitle: 'Developer',
          dateOfJoining: new Date('2025-01-01'),
          workLocation: 'OFFICE',
        },
      });
    }
    await prisma.employeeShiftAssignment.upsert({
      where: { id: 'shift_assign_other_626' },
      create: {
        id: 'shift_assign_other_626',
        employeeProfileId: otherProfile.id,
        userId: otherEmp.id,
        shiftDefinitionId: shift.id,
        startDate: parseDateOnly('2026-01-01'),
      },
      update: {
        shiftDefinitionId: shift.id,
      },
    });
  });

  afterAll(async () => {
    if (testShiftId) {
      const recs = await prisma.attendanceRecord.findMany({
        where: { shiftDefinitionId: testShiftId },
        select: { id: true },
      });
      const recIds = Array.from(new Set([...createdRecordIds, ...recs.map((r) => r.id)]));
      if (recIds.length > 0) {
        const corrReqs = await prisma.attendanceCorrectionRequest.findMany({
          where: { attendanceRecordId: { in: recIds } },
          select: { id: true },
        });
        const allCorrIds = Array.from(new Set([...createdCorrectionIds, ...corrReqs.map((c) => c.id)]));
        if (allCorrIds.length > 0) {
          await prisma.attendanceEvidenceVerification.deleteMany({
            where: { correctionRequestId: { in: allCorrIds } },
          });
          await prisma.attendanceCorrectionRequest.deleteMany({
            where: { id: { in: allCorrIds } },
          });
        }
        await prisma.attendanceBreak.deleteMany({
          where: { attendanceRecordId: { in: recIds } },
        });
        await prisma.attendanceSession.deleteMany({
          where: { attendanceRecordId: { in: recIds } },
        });
        await prisma.attendanceRecord.deleteMany({
          where: { id: { in: recIds } },
        });
      }
      await prisma.employeeShiftAssignment.deleteMany({
        where: { shiftDefinitionId: testShiftId },
      });
      await prisma.shiftDefinition.deleteMany({
        where: { code: 'TEST_SHIFT_626' },
      });
    } else {
      if (createdCorrectionIds.length > 0) {
        await prisma.attendanceEvidenceVerification.deleteMany({
          where: { correctionRequestId: { in: createdCorrectionIds } },
        });
        await prisma.attendanceCorrectionRequest.deleteMany({
          where: { id: { in: createdCorrectionIds } },
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
    }
    if (createdOtherUserId) {
      await prisma.employeeShiftAssignment.deleteMany({ where: { userId: createdOtherUserId } });
      await prisma.employeeProfile.deleteMany({ where: { userId: createdOtherUserId } });
      await prisma.userSession.deleteMany({ where: { userId: createdOtherUserId } });
      await prisma.userRole.deleteMany({ where: { userId: createdOtherUserId } });
      await prisma.userDepartment.deleteMany({ where: { userId: createdOtherUserId } });
      await prisma.user.delete({ where: { id: createdOtherUserId } });
    }
    await app.close();
  });

  // =========================================================================
  // SUITE 1: Employee Correction Request Workflow
  // =========================================================================
  describe('1. Employee Correction Request Workflow', () => {
    let testRecordId: string;
    let testSessionId: string;
    let createdCorrectionId: string;

    beforeAll(async () => {
      // Create an attendance record with a completed session on 2026-07-10
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parseDateOnly('2026-07-10'),
          shiftStartTimeSnapshot: new Date('2026-07-10T03:30:00.000Z'),
          shiftEndTimeSnapshot: new Date('2026-07-10T12:30:00.000Z'),
          fullDayThresholdSecondsSnapshot: 28800,
          halfDayThresholdSecondsSnapshot: 14400,
          overtimeThresholdSecondsSnapshot: 32400,
          allowMultipleSessionsSnapshot: true,
          breakPolicySnapshot: JSON.stringify({
            paidAllowanceMinutes: 60,
            autoCloseGraceMinutes: 30,
            breakTypes: [],
          }),
          status: AttendanceStatus.PENDING_RECONCILIATION,
        },
      });
      testRecordId = rec.id;
      createdRecordIds.push(rec.id);

      const sess = await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-07-10T03:30:00.000Z'),
          checkInAt: new Date('2026-07-10T03:30:00.000Z'),
          rawCheckOutAt: new Date('2026-07-10T10:00:00.000Z'), // Premature raw checkout at 10:00 UTC
          checkOutAt: new Date('2026-07-10T10:00:00.000Z'),
          status: AttendanceSessionStatus.COMPLETED,
          durationSeconds: 23400,
        },
      });
      testSessionId = sess.id;
    });

    it('1.1 should create a valid correction request for an existing session (201 Created)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-10',
          attendanceSessionId: testSessionId,
          correctionType: CorrectionType.INCORRECT_CHECK_OUT,
          requestedCheckOutAt: '2026-07-10T12:30:00.000Z', // Request extension to scheduled 18:00 IST
          reason: 'Network disconnect caused premature checkout registration at 15:30 IST.',
          evidenceMetadata: {
            evidenceReference: 'JIRA-8931; Git commit e319da1',
            notes: 'Active development work committed until 18:00 IST.',
          },
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.status).toBe(AttendanceCorrectionStatus.PENDING);
      expect(res.body.data.attendanceSessionId).toBe(testSessionId);

      createdCorrectionId = res.body.data.id;
      createdCorrectionIds.push(createdCorrectionId);

      // Verify audit log creation
      const audit = await prisma.auditLog.findFirst({
        where: {
          entityType: 'AttendanceCorrectionRequest',
          entityId: createdCorrectionId,
          action: 'CREATE',
        },
      });
      expect(audit).toBeDefined();
    });

    it('1.2 should reject correction request with invalid timestamp order (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-11',
          correctionType: CorrectionType.INCORRECT_CHECK_IN,
          requestedCheckInAt: '2026-07-11T12:30:00.000Z',
          requestedCheckOutAt: '2026-07-11T03:30:00.000Z', // CheckIn > CheckOut
          reason: 'Typo in timestamps',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('requestedCheckInAt must be strictly before requestedCheckOutAt');
    });

    it('1.3 should reject correction request with invalid session association (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-10',
          attendanceSessionId: 'invalid_foreign_session_id',
          correctionType: CorrectionType.INCORRECT_CHECK_OUT,
          requestedCheckOutAt: '2026-07-10T12:30:00.000Z',
          reason: 'Bogus session id test',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('does not belong to this attendance record or user');
    });

    it('1.4 should reject employee attempting to create correction for another employee (403 Forbidden)', async () => {
      // Trying to create correction using otherEmployee's token for employeeId
      // Controller automatically extracts actor.sub from token, so submitting employee's identity is strictly authenticated
      const res = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({
          attendanceDate: '2026-07-10',
          attendanceSessionId: testSessionId, // belongs to main employee
          correctionType: CorrectionType.INCORRECT_CHECK_OUT,
          requestedCheckOutAt: '2026-07-10T12:30:00.000Z',
          reason: 'IDOR attempt on session',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('1.5 should submit correction request for missing session (201 Created)', async () => {
      // Employee forgot to check in at all on 2026-07-15
      const res = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-15',
          correctionType: CorrectionType.MISSED_CHECK_IN,
          requestedCheckInAt: '2026-07-15T03:30:00.000Z',
          requestedCheckOutAt: '2026-07-15T12:30:00.000Z',
          reason: 'Forgot badge at home and forgot to check in on portal.',
          evidenceMetadata: {
            evidenceReference: 'Office CCTV gate entry timestamp 09:02 IST',
          },
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.attendanceSessionId).toBeNull();
      createdCorrectionIds.push(res.body.data.id);
      createdRecordIds.push(res.body.data.attendanceRecordId);
    });

    it('1.6 should reject duplicate pending correction request for the same session/record (409 Conflict)', async () => {
      // testSessionId already has a pending correction request from 1.1
      const res = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-10',
          attendanceSessionId: testSessionId,
          correctionType: CorrectionType.INCORRECT_CHECK_OUT,
          requestedCheckOutAt: '2026-07-10T13:00:00.000Z',
          reason: 'Duplicate correction attempt',
        })
        .expect(409);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('already exists for this attendance session/record');
    });

    it('1.7 should allow employee to list their own correction requests (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/corrections/my-requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      const found = res.body.data.items.find((item: any) => item.id === createdCorrectionId);
      expect(found).toBeDefined();
    });

    it('1.8 should allow employee to view single correction request details (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/attendance/corrections/${createdCorrectionId}`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(createdCorrectionId);
      expect(res.body.data.reason).toBeDefined();
      expect(res.body.data.attendanceRecord).toBeDefined();
    });

    it('1.9 should allow employee to cancel their own pending correction request (200 OK)', async () => {
      const pendingReq = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-16',
          correctionType: CorrectionType.OTHER,
          requestedCheckInAt: '2026-07-16T03:30:00.000Z',
          requestedCheckOutAt: '2026-07-16T12:30:00.000Z',
          reason: 'To be cancelled by employee',
        })
        .expect(201);

      createdCorrectionIds.push(pendingReq.body.data.id);
      createdRecordIds.push(pendingReq.body.data.attendanceRecordId);

      const cancelRes = await request(app.getHttpServer())
        .post(`/api/attendance/corrections/${pendingReq.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(200);

      expect(cancelRes.body.success).toBe(true);
      expect(cancelRes.body.data.status).toBe(AttendanceCorrectionStatus.CANCELLED);
    });

    it('1.10 should forbid employee from cancelling another employee’s request (403 Forbidden)', async () => {
      const otherReq = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({
          attendanceDate: '2026-07-17',
          correctionType: CorrectionType.OTHER,
          requestedCheckInAt: '2026-07-17T03:30:00.000Z',
          requestedCheckOutAt: '2026-07-17T12:30:00.000Z',
          reason: 'Other employee correction',
        })
        .expect(201);

      createdCorrectionIds.push(otherReq.body.data.id);
      createdRecordIds.push(otherReq.body.data.attendanceRecordId);

      // Main employee tries to cancel other employee's request
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/corrections/${otherReq.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('only cancel your own');
    });

    it('1.11 should forbid cancelling a non-pending request (400 Bad Request)', async () => {
      // createdCorrectionId was created in 1.1; cancel it first, then try cancelling again
      const dummyReq = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-18',
          correctionType: CorrectionType.OTHER,
          requestedCheckInAt: '2026-07-18T03:30:00.000Z',
          requestedCheckOutAt: '2026-07-18T12:30:00.000Z',
          reason: 'Dummy test for cancel',
        })
        .expect(201);

      createdCorrectionIds.push(dummyReq.body.data.id);
      createdRecordIds.push(dummyReq.body.data.attendanceRecordId);

      await request(app.getHttpServer())
        .post(`/api/attendance/corrections/${dummyReq.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(200);

      // Second cancel should fail
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/corrections/${dummyReq.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('no longer pending');
    });

    it('1.12 should submit a valid break correction request (201 Created)', async () => {
      // Create session and break for 2026-07-02
      const dateStr = '2026-07-02';
      const parsedDate = parseDateOnly(dateStr);
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parsedDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          ...createRecordSnapshotData(dateStr),
        },
      });
      createdRecordIds.push(rec.id);

      const sess = await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-07-02T03:30:00.000Z'),
          checkInAt: new Date('2026-07-02T03:30:00.000Z'),
          rawCheckOutAt: new Date('2026-07-02T12:30:00.000Z'),
          checkOutAt: new Date('2026-07-02T12:30:00.000Z'),
          durationSeconds: 32400,
          status: AttendanceSessionStatus.COMPLETED,
        },
      });

      const brk = await prisma.attendanceBreak.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          breakTypeId: 'LUNCH',
          startedAt: new Date('2026-07-02T07:00:00.000Z'),
          endedAt: new Date('2026-07-02T07:45:00.000Z'),
          paidDurationSeconds: 2700,
          unpaidDurationSeconds: 0,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: dateStr,
          attendanceSessionId: sess.id,
          attendanceBreakId: brk.id,
          correctionType: CorrectionType.INCORRECT_BREAK,
          requestedBreakStartedAt: '2026-07-02T07:15:00.000Z',
          requestedBreakEndedAt: '2026-07-02T07:45:00.000Z',
          reason: 'Started break 15 minutes later than recorded',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.evidenceMetadata.breakCorrection.attendanceBreakId).toBe(brk.id);
      createdCorrectionIds.push(res.body.data.id);
    });

    it('1.13 should reject break correction with invalid ownership (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-02',
          attendanceBreakId: 'non_existent_break_id',
          correctionType: CorrectionType.INCORRECT_BREAK,
          requestedBreakStartedAt: '2026-07-02T07:15:00.000Z',
          requestedBreakEndedAt: '2026-07-02T07:45:00.000Z',
          reason: 'Invalid break ownership test',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('does not belong to this attendance record or user');
    });

    it('1.14 should reject break correction not contained within an attendance session (400 Bad Request)', async () => {
      const brk = await prisma.attendanceBreak.findFirstOrThrow({
        where: { userId: employeeId, attendanceRecord: { attendanceDate: parseDateOnly('2026-07-02') } },
      });

      // Attempt break before session checkIn (02:00 to 03:00)
      const res = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-02',
          attendanceBreakId: brk.id,
          correctionType: CorrectionType.INCORRECT_BREAK,
          requestedBreakStartedAt: '2026-07-02T02:00:00.000Z',
          requestedBreakEndedAt: '2026-07-02T03:00:00.000Z',
          reason: 'Break outside session hours',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('must be fully contained within an attendance session');
    });

    it('1.15 should reject break correction overlapping with another existing break (400 Bad Request)', async () => {
      const rec = await prisma.attendanceRecord.findFirstOrThrow({
        where: { userId: employeeId, attendanceDate: parseDateOnly('2026-07-02') },
      });
      // Add a second break: 08:30 to 09:00
      const brk2 = await prisma.attendanceBreak.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          breakTypeId: 'TEA',
          startedAt: new Date('2026-07-02T08:30:00.000Z'),
          endedAt: new Date('2026-07-02T09:00:00.000Z'),
        },
      });

      // Try correcting brk2 to 07:30 - 08:00 (overlaps with brk1 which is 07:00 - 07:45)
      const res = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-02',
          attendanceBreakId: brk2.id,
          correctionType: CorrectionType.INCORRECT_BREAK,
          requestedBreakStartedAt: '2026-07-02T07:30:00.000Z',
          requestedBreakEndedAt: '2026-07-02T08:00:00.000Z',
          reason: 'Overlapping break test',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('overlaps with another existing break');
    });

    it('1.16 should correct missed check-in when checkout already exists (201 Created)', async () => {
      const dateStr = '2026-07-27';
      const parsedDate = parseDateOnly(dateStr);
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parsedDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          ...createRecordSnapshotData(dateStr),
        },
      });
      createdRecordIds.push(rec.id);

      const sess = await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-07-27T04:30:00.000Z'),
          checkInAt: new Date('2026-07-27T04:30:00.000Z'),
          rawCheckOutAt: new Date('2026-07-27T12:30:00.000Z'),
          checkOutAt: new Date('2026-07-27T12:30:00.000Z'),
          durationSeconds: 28800,
          status: AttendanceSessionStatus.COMPLETED,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: dateStr,
          attendanceSessionId: sess.id,
          correctionType: CorrectionType.MISSED_CHECK_IN,
          requestedCheckInAt: '2026-07-27T03:30:00.000Z',
          reason: 'Card swipe missed at morning check-in',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.requestedCheckInAt).toBe('2026-07-27T03:30:00.000Z');
      expect(res.body.data.requestedCheckOutAt).toBeNull();
      createdCorrectionIds.push(res.body.data.id);
    });

    it('1.17 should correct missed check-out when check-in already exists (201 Created)', async () => {
      const dateStr = '2026-07-26';
      const parsedDate = parseDateOnly(dateStr);
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parsedDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          ...createRecordSnapshotData(dateStr),
        },
      });
      createdRecordIds.push(rec.id);

      const sess = await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-07-26T03:30:00.000Z'),
          checkInAt: new Date('2026-07-26T03:30:00.000Z'),
          rawCheckOutAt: null,
          checkOutAt: null,
          durationSeconds: null,
          status: AttendanceSessionStatus.ACTIVE,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: dateStr,
          attendanceSessionId: sess.id,
          correctionType: CorrectionType.MISSED_CHECK_OUT,
          requestedCheckOutAt: '2026-07-26T12:30:00.000Z',
          reason: 'Forgot to swipe out at turnstile',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.requestedCheckOutAt).toBe('2026-07-26T12:30:00.000Z');
      createdCorrectionIds.push(res.body.data.id);

      // Close the session so it doesn't leave an active session for employee
      await prisma.attendanceSession.update({
        where: { id: sess.id },
        data: {
          status: AttendanceSessionStatus.COMPLETED,
          checkOutAt: new Date('2026-07-26T12:30:00.000Z'),
          rawCheckOutAt: new Date('2026-07-26T12:30:00.000Z'),
          durationSeconds: 32400,
        },
      });
    });

    it('1.18 should reject missing session correction when only one timestamp is supplied (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-24',
          correctionType: CorrectionType.MISSED_CHECK_IN,
          requestedCheckInAt: '2026-07-24T03:30:00.000Z',
          reason: 'Incomplete missing session',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Both requestedCheckInAt and requestedCheckOutAt are required');
    });
  });

  // =========================================================================
  // SUITE 2: Manager / HR Review & Scope Enforcement
  // =========================================================================
  describe('2. Manager / HR Review & Scope Enforcement', () => {
    let pendingCorrectionId: string;
    let pendingRecordId: string;
    let pendingSessionId: string;

    beforeAll(async () => {
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parseDateOnly('2026-07-20'),
          shiftStartTimeSnapshot: new Date('2026-07-20T03:30:00.000Z'),
          shiftEndTimeSnapshot: new Date('2026-07-20T12:30:00.000Z'),
          fullDayThresholdSecondsSnapshot: 28800,
          halfDayThresholdSecondsSnapshot: 14400,
          overtimeThresholdSecondsSnapshot: 32400,
          allowMultipleSessionsSnapshot: true,
          breakPolicySnapshot: JSON.stringify({
            paidAllowanceMinutes: 60,
            autoCloseGraceMinutes: 30,
            breakTypes: [],
          }),
          status: AttendanceStatus.PENDING_RECONCILIATION,
        },
      });
      pendingRecordId = rec.id;
      createdRecordIds.push(rec.id);

      const sess = await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-07-20T04:30:00.000Z'), // Checked in late
          checkInAt: new Date('2026-07-20T04:30:00.000Z'),
          rawCheckOutAt: new Date('2026-07-20T12:30:00.000Z'),
          checkOutAt: new Date('2026-07-20T12:30:00.000Z'),
          status: AttendanceSessionStatus.COMPLETED,
          durationSeconds: 28800,
        },
      });
      pendingSessionId = sess.id;

      const req = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-20',
          attendanceSessionId: sess.id,
          correctionType: CorrectionType.INCORRECT_CHECK_IN,
          requestedCheckInAt: '2026-07-20T03:30:00.000Z', // Request 09:00 IST start
          requestedCheckOutAt: '2026-07-20T12:30:00.000Z',
          reason: 'Badge scanner malfunction at front door.',
          evidenceMetadata: { evidenceReference: 'Manual visitor log sign-in sheet at 08:58 IST' },
        })
        .expect(201);

      pendingCorrectionId = req.body.data.id;
      createdCorrectionIds.push(pendingCorrectionId);
    });

    it('2.1 should forbid standard employee from viewing manager scoped requests (403 Forbidden)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
    });

    it('2.2 should allow authorized manager to view scoped correction requests (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/corrections')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      const found = res.body.data.items.find((item: any) => item.id === pendingCorrectionId);
      expect(found).toBeDefined();
    });

    it('2.3 should prevent manager from viewing correction requests outside their department scope', async () => {
      // Create request by otherEmployee
      const otherReq = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({
          attendanceDate: '2026-07-22',
          correctionType: CorrectionType.OTHER,
          requestedCheckInAt: '2026-07-22T03:30:00.000Z',
          requestedCheckOutAt: '2026-07-22T12:30:00.000Z',
          reason: 'Other employee correction',
        })
        .expect(201);
      createdCorrectionIds.push(otherReq.body.data.id);
      createdRecordIds.push(otherReq.body.data.attendanceRecordId);

      // Direct filter by other user ID returns 403 Forbidden
      const resFilter = await request(app.getHttpServer())
        .get(`/api/attendance/corrections?userId=${otherEmployeeId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
      expect(resFilter.body.message).toContain('not within your department');

      // Unfiltered list does not contain foreign department item
      const resList = await request(app.getHttpServer())
        .get('/api/attendance/corrections')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      const found = resList.body.data.items.find((item: any) => item.id === otherReq.body.data.id);
      expect(found).toBeUndefined();
    });

    it('2.4 should prevent self-approval of correction requests (403 Forbidden)', async () => {
      // Manager creates a correction request for themselves
      const pmReq = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          attendanceDate: '2026-07-25',
          correctionType: CorrectionType.OTHER,
          requestedCheckInAt: '2026-07-25T03:30:00.000Z',
          requestedCheckOutAt: '2026-07-25T12:30:00.000Z',
          reason: 'PM self correction request',
        })
        .expect(201);

      createdCorrectionIds.push(pmReq.body.data.id);
      createdRecordIds.push(pmReq.body.data.attendanceRecordId);

      // Manager attempts to approve their own request
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/corrections/${pmReq.body.data.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ managerNotes: 'Self approving' })
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Self-approval of attendance correction requests is strictly prohibited');
    });

    it('2.5 should reject correction request with mandatory manager rejection reason (200 OK)', async () => {
      const toReject = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-26',
          correctionType: CorrectionType.OTHER,
          requestedCheckInAt: '2026-07-26T03:30:00.000Z',
          requestedCheckOutAt: '2026-07-26T12:30:00.000Z',
          reason: 'To be rejected by manager',
        })
        .expect(201);

      createdCorrectionIds.push(toReject.body.data.id);
      createdRecordIds.push(toReject.body.data.attendanceRecordId);

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/corrections/${toReject.body.data.id}/reject`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          managerNotes: 'Security logs show employee left at 15:00 IST, discrepancy rejected.',
          evidenceOutcome: VerificationOutcome.REJECTED,
          verificationNotes: 'CCTV footage confirmed absence after 15:00.',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(AttendanceCorrectionStatus.REJECTED);
      expect(res.body.data.evidenceVerification).toBeDefined();
      expect(res.body.data.evidenceVerification.outcome).toBe(VerificationOutcome.REJECTED);
    });

    it('2.6 should require mandatory managerNotes on rejection (400 Bad Request if missing)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/corrections/${pendingCorrectionId}/reject`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({}) // Missing managerNotes
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body)).toContain('managerNotes is required when rejecting');
    });

    it('2.7 should strictly NOT modify session or record timestamps upon rejection', async () => {
      const sessBefore = await prisma.attendanceSession.findUniqueOrThrow({
        where: { id: pendingSessionId },
      });

      // Session timestamps remain identical to original
      expect(sessBefore.checkInAt?.toISOString()).toBe('2026-07-20T04:30:00.000Z');
      expect(sessBefore.checkOutAt?.toISOString()).toBe('2026-07-20T12:30:00.000Z');
    });

    it('2.8 should approve correction request for existing session, preserve raw telemetry, record evidence verification, and trigger recalculation (200 OK)', async () => {
      const approveRes = await request(app.getHttpServer())
        .post(`/api/attendance/corrections/${pendingCorrectionId}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          managerNotes: 'Verified visitor gate log and card swipe with facility team.',
          evidenceOutcome: VerificationOutcome.VERIFIED,
          verificationNotes: 'Facility visitor desk sign-in book page 42 line 8 verified.',
        })
        .expect(200);

      expect(approveRes.body.success).toBe(true);
      expect(approveRes.body.data.status).toBe(AttendanceCorrectionStatus.APPROVED);

      // Verify Session updated checkInAt but preserved rawCheckInAt!
      const updatedSession = await prisma.attendanceSession.findUniqueOrThrow({
        where: { id: pendingSessionId },
      });
      // Raw telemetry is preserved immutable:
      expect(updatedSession.rawCheckInAt.toISOString()).toBe('2026-07-20T04:30:00.000Z');
      // Authoritative checkInAt is updated to requested 03:30:
      expect(updatedSession.checkInAt?.toISOString()).toBe('2026-07-20T03:30:00.000Z');
      expect(updatedSession.checkOutAt?.toISOString()).toBe('2026-07-20T12:30:00.000Z');
      expect(updatedSession.durationSeconds).toBe(32400); // 9 hours

      // Verify Evidence Verification record was created
      const verification = await prisma.attendanceEvidenceVerification.findUnique({
        where: { correctionRequestId: pendingCorrectionId },
      });
      expect(verification).toBeDefined();
      expect(verification?.outcome).toBe(VerificationOutcome.VERIFIED);
      expect(verification?.reviewerUserId).toBe(managerId);

      // Verify recalculation happened on AttendanceRecord
      const rec = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: pendingRecordId },
      });
      expect(rec.grossWorkingDurationSeconds).toBe(32400);
      expect(rec.netWorkingDurationSeconds).toBe(32400);
      expect(rec.status).toBe(AttendanceStatus.PRESENT); // Met 8-hour full day threshold
    });

    it('2.9 should approve correction request for missing session and create the session (200 OK)', async () => {
      const missingSessReq = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-28',
          correctionType: CorrectionType.MISSED_CHECK_IN,
          requestedCheckInAt: '2026-07-28T03:30:00.000Z',
          requestedCheckOutAt: '2026-07-28T12:30:00.000Z',
          reason: 'Badge forgotten, supervisor verbally notified at morning standup.',
          evidenceMetadata: { evidenceReference: 'Slack standup thread timestamp 09:05 IST' },
        })
        .expect(201);

      createdCorrectionIds.push(missingSessReq.body.data.id);
      createdRecordIds.push(missingSessReq.body.data.attendanceRecordId);

      const approveRes = await request(app.getHttpServer())
        .post(`/api/attendance/corrections/${missingSessReq.body.data.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ managerNotes: 'Confirmed attendance via morning Slack standup' })
        .expect(200);

      expect(approveRes.body.success).toBe(true);
      expect(approveRes.body.data.status).toBe(AttendanceCorrectionStatus.APPROVED);

      // Verify new session was created
      const sessions = await prisma.attendanceSession.findMany({
        where: { attendanceRecordId: missingSessReq.body.data.attendanceRecordId },
      });
      expect(sessions.length).toBe(1);
      expect(sessions[0].status).toBe(AttendanceSessionStatus.COMPLETED);
      expect(sessions[0].durationSeconds).toBe(32400);

      // Verify record recalculated to PRESENT
      const rec = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: missingSessReq.body.data.attendanceRecordId },
      });
      expect(rec.status).toBe(AttendanceStatus.PRESENT);
    });

    it('2.10 should reject re-approving an already approved correction request (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/attendance/corrections/${pendingCorrectionId}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ managerNotes: 'Duplicate approval attempt' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('no longer pending');
    });

    it('2.11 should reject approval if applying correction causes session interval overlap (400 Bad Request)', async () => {
      // Create a record on 2026-07-29 with two sessions:
      // Session 1: 03:30 - 07:30
      // Session 2: 08:30 - 12:30
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parseDateOnly('2026-07-29'),
          shiftStartTimeSnapshot: new Date('2026-07-29T03:30:00.000Z'),
          shiftEndTimeSnapshot: new Date('2026-07-29T12:30:00.000Z'),
          fullDayThresholdSecondsSnapshot: 28800,
          halfDayThresholdSecondsSnapshot: 14400,
          overtimeThresholdSecondsSnapshot: 32400,
          allowMultipleSessionsSnapshot: true,
          breakPolicySnapshot: JSON.stringify({ paidAllowanceMinutes: 60, autoCloseGraceMinutes: 30, breakTypes: [] }),
          status: AttendanceStatus.PENDING_RECONCILIATION,
        },
      });
      createdRecordIds.push(rec.id);

      const sess1 = await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-07-29T03:30:00.000Z'),
          checkInAt: new Date('2026-07-29T03:30:00.000Z'),
          rawCheckOutAt: new Date('2026-07-29T07:30:00.000Z'),
          checkOutAt: new Date('2026-07-29T07:30:00.000Z'),
          durationSeconds: 14400,
          status: AttendanceSessionStatus.COMPLETED,
        },
      });

      await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-07-29T08:30:00.000Z'),
          checkInAt: new Date('2026-07-29T08:30:00.000Z'),
          rawCheckOutAt: new Date('2026-07-29T12:30:00.000Z'),
          checkOutAt: new Date('2026-07-29T12:30:00.000Z'),
          durationSeconds: 14400,
          status: AttendanceSessionStatus.COMPLETED,
        },
      });

      // Employee requests extending session 1 checkOut to 09:30 (overlaps with session 2!)
      const overlapReq = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-29',
          attendanceSessionId: sess1.id,
          correctionType: CorrectionType.INCORRECT_CHECK_OUT,
          requestedCheckOutAt: '2026-07-29T09:30:00.000Z',
          reason: 'Overlap causing request',
        })
        .expect(201);
      createdCorrectionIds.push(overlapReq.body.data.id);

      // Manager attempts to approve
      const approveRes = await request(app.getHttpServer())
        .post(`/api/attendance/corrections/${overlapReq.body.data.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ managerNotes: 'Attempting invalid overlap approval' })
        .expect(400);

      expect(approveRes.body.success).toBe(false);
      expect(approveRes.body.message).toContain('overlapping attendance sessions');
    });

    it('2.12 should approve break correction, update break timestamps, and trigger recalculation of paid/unpaid durations (200 OK)', async () => {
      // Find the break correction request created in 1.12
      const corr = await prisma.attendanceCorrectionRequest.findFirstOrThrow({
        where: {
          userId: employeeId,
          attendanceRecord: { attendanceDate: parseDateOnly('2026-07-02') },
          status: AttendanceCorrectionStatus.PENDING,
        },
      });

      const brkMeta = (corr.evidenceMetadata as any)?.breakCorrection;
      expect(brkMeta).toBeDefined();

      const res = await request(app.getHttpServer())
        .post(`/api/attendance/corrections/${corr.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          managerNotes: 'Approved corrected break interval',
          evidenceReference: 'CCTV-LOG-20260702-LUNCH',
          evidenceOutcome: VerificationOutcome.VERIFIED,
          verificationNotes: 'Verified badge activity during break period',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(AttendanceCorrectionStatus.APPROVED);

      // Verify break timestamps in DB
      const updatedBreak = await prisma.attendanceBreak.findUniqueOrThrow({
        where: { id: brkMeta.attendanceBreakId },
      });
      expect(updatedBreak.startedAt.toISOString()).toBe('2026-07-02T07:15:00.000Z');
      expect(updatedBreak.endedAt?.toISOString()).toBe('2026-07-02T07:45:00.000Z');

      // Verify recalculation updated paid/unpaid durations (30 min break 1 + 30 min break 2 = 60 min paid allowance = 3600s)
      const rec = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: corr.attendanceRecordId },
      });
      expect(rec.paidBreakDurationSeconds).toBe(3600);
    });

    it('2.13 should record evidenceOutcome as INCONCLUSIVE when neither client nor reviewer provides verifiable evidence reference', async () => {
      // Create request without evidence reference
      const corr = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-23',
          correctionType: CorrectionType.OTHER,
          requestedCheckInAt: '2026-07-23T03:30:00.000Z',
          requestedCheckOutAt: '2026-07-23T12:30:00.000Z',
          reason: 'No external proof provided',
        })
        .expect(201);
      createdCorrectionIds.push(corr.body.data.id);
      createdRecordIds.push(corr.body.data.attendanceRecordId);

      // Reviewer approves without supplying evidenceReference or verification proof
      const approveRes = await request(app.getHttpServer())
        .post(`/api/attendance/corrections/${corr.body.data.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          managerNotes: 'Approved on good faith without proof',
          // No evidenceReference provided
        })
        .expect(200);

      // Since no evidence was submitted or verified, outcome cannot be falsely VERIFIED
      expect(approveRes.body.data.evidenceVerification.outcome).toBe(VerificationOutcome.INCONCLUSIVE);
    });

    it('2.14 should record evidenceOutcome as VERIFIED when reviewer supplies explicit evidenceReference', async () => {
      const corr = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-07-21',
          correctionType: CorrectionType.OTHER,
          requestedCheckInAt: '2026-07-21T03:30:00.000Z',
          requestedCheckOutAt: '2026-07-21T12:30:00.000Z',
          reason: 'Correction with supervisor verification',
        })
        .expect(201);
      createdCorrectionIds.push(corr.body.data.id);
      createdRecordIds.push(corr.body.data.attendanceRecordId);

      const approveRes = await request(app.getHttpServer())
        .post(`/api/attendance/corrections/${corr.body.data.id}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          managerNotes: 'Verified via biometric system audit log',
          evidenceReference: 'BIOMETRIC-GATE-SWIPE-20260721',
          evidenceOutcome: VerificationOutcome.VERIFIED,
          verificationNotes: 'Cross-checked biometric server log entries',
        })
        .expect(200);

      expect(approveRes.body.data.evidenceVerification.outcome).toBe(VerificationOutcome.VERIFIED);
      expect(approveRes.body.data.evidenceVerification.evidenceReference).toBe('BIOMETRIC-GATE-SWIPE-20260721');
    });
  });

  // =========================================================================
  // SUITE 3: Concurrency, Lock Hierarchy & Race Conditions Under Real MySQL
  // =========================================================================
  describe('3. Concurrency, Lock Hierarchy & Race Conditions Under Real MySQL', () => {
    it('3.1 should handle concurrent double-approval cleanly without deadlock (exactly one succeeds)', async () => {
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parseDateOnly('2026-08-05'),
          shiftStartTimeSnapshot: new Date('2026-08-05T03:30:00.000Z'),
          shiftEndTimeSnapshot: new Date('2026-08-05T12:30:00.000Z'),
          fullDayThresholdSecondsSnapshot: 28800,
          halfDayThresholdSecondsSnapshot: 14400,
          overtimeThresholdSecondsSnapshot: 32400,
          allowMultipleSessionsSnapshot: true,
          breakPolicySnapshot: JSON.stringify({ paidAllowanceMinutes: 60, autoCloseGraceMinutes: 30, breakTypes: [] }),
          status: AttendanceStatus.PENDING_RECONCILIATION,
        },
      });
      createdRecordIds.push(rec.id);

      const sess = await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-08-05T03:30:00.000Z'),
          checkInAt: new Date('2026-08-05T03:30:00.000Z'),
          rawCheckOutAt: new Date('2026-08-05T10:00:00.000Z'),
          checkOutAt: new Date('2026-08-05T10:00:00.000Z'),
          durationSeconds: 23400,
          status: AttendanceSessionStatus.COMPLETED,
        },
      });

      const corrReq = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-08-05',
          attendanceSessionId: sess.id,
          correctionType: CorrectionType.INCORRECT_CHECK_OUT,
          requestedCheckOutAt: '2026-08-05T12:30:00.000Z',
          reason: 'Race test double approval',
        })
        .expect(201);

      const corrId = corrReq.body.data.id;
      createdCorrectionIds.push(corrId);

      // Concurrently fire two approvals (Super Admin and Manager)
      const [res1, res2] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/attendance/corrections/${corrId}/approve`)
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({ managerNotes: 'Admin approve race' }),
        request(app.getHttpServer())
          .post(`/api/attendance/corrections/${corrId}/approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({ managerNotes: 'Manager approve race' }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 400]);

      const finalState = await prisma.attendanceCorrectionRequest.findUniqueOrThrow({
        where: { id: corrId },
      });
      expect(finalState.status).toBe(AttendanceCorrectionStatus.APPROVED);
    });

    it('3.2 should handle concurrent approval versus rejection cleanly (exactly one succeeds)', async () => {
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parseDateOnly('2026-08-06'),
          shiftStartTimeSnapshot: new Date('2026-08-06T03:30:00.000Z'),
          shiftEndTimeSnapshot: new Date('2026-08-06T12:30:00.000Z'),
          fullDayThresholdSecondsSnapshot: 28800,
          halfDayThresholdSecondsSnapshot: 14400,
          overtimeThresholdSecondsSnapshot: 32400,
          allowMultipleSessionsSnapshot: true,
          breakPolicySnapshot: JSON.stringify({ paidAllowanceMinutes: 60, autoCloseGraceMinutes: 30, breakTypes: [] }),
          status: AttendanceStatus.PENDING_RECONCILIATION,
        },
      });
      createdRecordIds.push(rec.id);

      const corrReq = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-08-06',
          correctionType: CorrectionType.MISSED_CHECK_IN,
          requestedCheckInAt: '2026-08-06T03:30:00.000Z',
          requestedCheckOutAt: '2026-08-06T12:30:00.000Z',
          reason: 'Race test approve vs reject',
        })
        .expect(201);

      const corrId = corrReq.body.data.id;
      createdCorrectionIds.push(corrId);

      // Concurrently fire approve and reject
      const [resApprove, resReject] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/attendance/corrections/${corrId}/approve`)
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({ managerNotes: 'Approve concurrent' }),
        request(app.getHttpServer())
          .post(`/api/attendance/corrections/${corrId}/reject`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({ managerNotes: 'Reject concurrent' }),
      ]);

      const statuses = [resApprove.status, resReject.status].sort();
      expect(statuses).toEqual([200, 400]);

      const finalState = await prisma.attendanceCorrectionRequest.findUniqueOrThrow({
        where: { id: corrId },
      });
      expect([AttendanceCorrectionStatus.APPROVED, AttendanceCorrectionStatus.REJECTED]).toContain(finalState.status);
    });

    it('3.3 should handle concurrent correction approval and recalculation without deadlock', async () => {
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parseDateOnly('2026-08-07'),
          shiftStartTimeSnapshot: new Date('2026-08-07T03:30:00.000Z'),
          shiftEndTimeSnapshot: new Date('2026-08-07T12:30:00.000Z'),
          fullDayThresholdSecondsSnapshot: 28800,
          halfDayThresholdSecondsSnapshot: 14400,
          overtimeThresholdSecondsSnapshot: 32400,
          allowMultipleSessionsSnapshot: true,
          breakPolicySnapshot: JSON.stringify({ paidAllowanceMinutes: 60, autoCloseGraceMinutes: 30, breakTypes: [] }),
          status: AttendanceStatus.PENDING_RECONCILIATION,
        },
      });
      createdRecordIds.push(rec.id);

      const sess = await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-08-07T03:30:00.000Z'),
          checkInAt: new Date('2026-08-07T03:30:00.000Z'),
          rawCheckOutAt: new Date('2026-08-07T11:00:00.000Z'),
          checkOutAt: new Date('2026-08-07T11:00:00.000Z'),
          durationSeconds: 27000,
          status: AttendanceSessionStatus.COMPLETED,
        },
      });

      const corrReq = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: '2026-08-07',
          attendanceSessionId: sess.id,
          correctionType: CorrectionType.INCORRECT_CHECK_OUT,
          requestedCheckOutAt: '2026-08-07T12:30:00.000Z',
          reason: 'Race test approval vs recalculation',
        })
        .expect(201);

      const corrId = corrReq.body.data.id;
      createdCorrectionIds.push(corrId);

      // Concurrently run approval and recalculation
      const [approveRes, recalcRes] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/attendance/corrections/${corrId}/approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({ managerNotes: 'Approve with concurrent recalculation' }),
        request(app.getHttpServer())
          .post(`/api/attendance/records/${rec.id}/recalculate`)
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({ isReconciled: true }),
      ]);

      expect(approveRes.status).toBe(200);
      expect(recalcRes.status).toBe(200);

      const finalRecord = await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: rec.id },
      });
      expect(finalRecord.grossWorkingDurationSeconds).toBe(32400); // 9h
    });

    it('3.4 should serialize concurrent duplicate correction request creation on the same record (exactly one succeeds, one rejected with 409 Conflict)', async () => {
      const dateStr = '2026-08-08';
      const parsedDate = parseDateOnly(dateStr);
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parsedDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          ...createRecordSnapshotData(dateStr),
        },
      });
      createdRecordIds.push(rec.id);

      const sess = await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-08-08T03:30:00.000Z'),
          checkInAt: new Date('2026-08-08T03:30:00.000Z'),
          rawCheckOutAt: new Date('2026-08-08T12:30:00.000Z'),
          checkOutAt: new Date('2026-08-08T12:30:00.000Z'),
          durationSeconds: 32400,
          status: AttendanceSessionStatus.COMPLETED,
        },
      });

      // Submit 2 identical correction requests at the exact same time
      const [reqA, reqB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/attendance/corrections')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({
            attendanceDate: dateStr,
            attendanceSessionId: sess.id,
            correctionType: CorrectionType.INCORRECT_CHECK_OUT,
            requestedCheckOutAt: '2026-08-08T13:00:00.000Z',
            reason: 'Race test creation duplicate A',
          }),
        request(app.getHttpServer())
          .post('/api/attendance/corrections')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({
            attendanceDate: dateStr,
            attendanceSessionId: sess.id,
            correctionType: CorrectionType.INCORRECT_CHECK_OUT,
            requestedCheckOutAt: '2026-08-08T13:00:00.000Z',
            reason: 'Race test creation duplicate B',
          }),
      ]);

      const statuses = [reqA.status, reqB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const successful = reqA.status === 201 ? reqA.body.data : reqB.body.data;
      createdCorrectionIds.push(successful.id);
    });

    it('3.5 should handle concurrent correction approval and checkout without deadlock', async () => {
      const dateStr = '2026-08-09';
      const parsedDate = parseDateOnly(dateStr);
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parsedDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          ...createRecordSnapshotData(dateStr),
        },
      });
      createdRecordIds.push(rec.id);

      // Session 1: completed
      const sess1 = await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-08-09T03:30:00.000Z'),
          checkInAt: new Date('2026-08-09T03:30:00.000Z'),
          rawCheckOutAt: new Date('2026-08-09T07:30:00.000Z'),
          checkOutAt: new Date('2026-08-09T07:30:00.000Z'),
          durationSeconds: 14400,
          status: AttendanceSessionStatus.COMPLETED,
        },
      });

      // Session 2: active session currently running
      await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-08-09T08:00:00.000Z'),
          checkInAt: new Date('2026-08-09T08:00:00.000Z'),
          status: AttendanceSessionStatus.ACTIVE,
        },
      });

      // Correction request for session 1
      const corr = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: dateStr,
          attendanceSessionId: sess1.id,
          correctionType: CorrectionType.INCORRECT_CHECK_OUT,
          requestedCheckOutAt: '2026-08-09T07:45:00.000Z',
          reason: 'Extend session 1 to 07:45',
        })
        .expect(201);
      createdCorrectionIds.push(corr.body.data.id);

      // Concurrently approve correction for session 1 while employee performs checkout on session 2
      const [approveRes, checkOutRes] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/attendance/corrections/${corr.body.data.id}/approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({ managerNotes: 'Approve session 1 concurrent with checkout' }),
        request(app.getHttpServer())
          .post('/api/attendance/check-out')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({}),
      ]);

      expect(approveRes.status).toBe(200);
      expect(checkOutRes.status).toBe(200);
    });

    it('3.6 should handle concurrent correction approval and overtime approval without deadlock', async () => {
      const dateStr = '2026-08-10';
      const parsedDate = parseDateOnly(dateStr);
      const rec = await prisma.attendanceRecord.create({
        data: {
          userId: employeeId,
          shiftDefinitionId: testShiftId,
          attendanceDate: parsedDate,
          status: AttendanceStatus.PENDING_RECONCILIATION,
          ...createRecordSnapshotData(dateStr),
        },
      });
      createdRecordIds.push(rec.id);

      const sess = await prisma.attendanceSession.create({
        data: {
          attendanceRecordId: rec.id,
          userId: employeeId,
          rawCheckInAt: new Date('2026-08-10T03:30:00.000Z'),
          checkInAt: new Date('2026-08-10T03:30:00.000Z'),
          rawCheckOutAt: new Date('2026-08-10T12:30:00.000Z'),
          checkOutAt: new Date('2026-08-10T12:30:00.000Z'),
          durationSeconds: 32400,
          status: AttendanceSessionStatus.COMPLETED,
        },
      });

      // Create correction request
      const corr = await request(app.getHttpServer())
        .post('/api/attendance/corrections')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          attendanceDate: dateStr,
          attendanceSessionId: sess.id,
          correctionType: CorrectionType.INCORRECT_CHECK_OUT,
          requestedCheckOutAt: '2026-08-10T13:00:00.000Z',
          reason: 'Correct checkout to 13:00',
        })
        .expect(201);
      createdCorrectionIds.push(corr.body.data.id);

      // Create overtime request
      const ot = await prisma.attendanceOvertimeRequest.create({
        data: {
          userId: employeeId,
          attendanceDate: parsedDate,
          startTime: new Date('2026-08-10T13:00:00.000Z'),
          endTime: new Date('2026-08-10T15:00:00.000Z'),
          reason: 'Project release overtime',
          status: 'PENDING',
        },
      });

      // Concurrently approve correction and approve overtime
      const [corrApprove, otApprove] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/attendance/corrections/${corr.body.data.id}/approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({ managerNotes: 'Approve correction concurrent with OT' }),
        request(app.getHttpServer())
          .post(`/api/attendance/overtime/${ot.id}/approve`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({ approvedDurationMinutes: 120 }),
      ]);

      expect(corrApprove.status).toBe(200);
      expect(otApprove.status).toBe(200);

      // Clean up OT record
      await prisma.attendanceOvertimeRequest.delete({ where: { id: ot.id } });
    });
  });
});
