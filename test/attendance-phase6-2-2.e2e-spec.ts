import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { RecordStatus } from '../src/generated/prisma/enums';

describe('Phase 6.2.2: Attendance Shift Management & Policy Engine (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  let superAdminToken: string;
  let superAdminId: string;

  let employeeToken: string;
  let employeeId: string;

  let otherEmployeeToken: string;
  let otherEmployeeId: string;
  let newlyCreatedOtherEmpId: string | null = null;

  let createdShiftId: string;
  let secondaryShiftId: string;
  let assignmentId1: string;
  let assignmentId2: string;

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

    // 1. Get Super Admin
    const superAdmin = await prisma.user.findFirst({
      where: {
        userType: { code: 'SUPER_ADMIN' },
        deletedAt: null,
      },
    });

    if (!superAdmin) {
      throw new Error('Super Admin user not found in database.');
    }
    superAdminId = superAdmin.id;

    const superAdminSession = await prisma.userSession.create({
      data: {
        userId: superAdmin.id,
        refreshTokenHash: 'e2e_shift_sa_' + Date.now(),
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
        sessionId: superAdminSession.id,
      },
      {
        secret: 'slash@202612354',
        expiresIn: '15m',
      },
    );

    // 2. Find or create test Employee with DEVELOPER role
    let emp = await prisma.user.findFirst({
      where: {
        userType: { code: 'EMPLOYEE' },
        userRoles: { some: { role: { code: 'DEVELOPER' } } },
        deletedAt: null,
        status: RecordStatus.ACTIVE,
      },
      include: { employeeProfile: true },
    });

    if (!emp || !emp.employeeProfile) {
      throw new Error('Active employee with profile and DEVELOPER role not found.');
    }
    employeeId = emp.id;

    const empSession = await prisma.userSession.create({
      data: {
        userId: emp.id,
        refreshTokenHash: 'e2e_shift_emp_' + Date.now(),
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
      {
        secret: 'slash@202612354',
        expiresIn: '15m',
      },
    );

    // 3. Find or create second employee to test isolation / data scopes
    const empUserType = await prisma.userType.findUnique({
      where: { code: 'EMPLOYEE' },
    });
    const devRole = await prisma.role.findUnique({
      where: { code: 'DEVELOPER' },
    });

    let otherEmp = await prisma.user.findFirst({
      where: {
        id: { not: emp.id },
        userType: { code: 'EMPLOYEE' },
        deletedAt: null,
        status: RecordStatus.ACTIVE,
      },
      include: { employeeProfile: true },
    });

    let newlyCreatedOtherEmpId: string | null = null;
    if (!otherEmp || !otherEmp.employeeProfile) {
      const ts = Date.now();
      otherEmp = await prisma.user.create({
        data: {
          userCode: 'EMP_SEC_' + ts.toString().slice(-4),
          email: `e2e_other_${ts}@slash.test`,
          name: 'QA Test Employee',
          userTypeId: empUserType!.id,
          status: RecordStatus.ACTIVE,
          emailVerifiedAt: new Date(),
          employeeProfile: {
            create: {
              employeeNumber: 'EMP_SEC_NUM_' + ts.toString().slice(-4),
              designation: 'QA Engineer',
            },
          },
          userRoles: {
            create: {
              roleId: devRole!.id,
            },
          },
        },
        include: { employeeProfile: true },
      });
      newlyCreatedOtherEmpId = otherEmp.id;
    }
    otherEmployeeId = otherEmp.id;

    const otherEmpSession = await prisma.userSession.create({
      data: {
        userId: otherEmp.id,
        refreshTokenHash: 'e2e_shift_other_emp_' + Date.now(),
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
        sessionId: otherEmpSession.id,
      },
      {
        secret: 'slash@202612354',
        expiresIn: '15m',
      },
    );

    // Clean up any pre-existing test shifts and assignments with test codes
    await prisma.employeeShiftAssignment.deleteMany({
      where: {
        OR: [
          { shiftDefinition: { code: { in: ['E2E_GEN_SHIFT', 'E2E_NIGHT_SHIFT', 'E2E_SEC_SHIFT'] } } },
          { userId: { in: [employeeId, otherEmployeeId] } },
        ],
      },
    });

    await prisma.shiftDefinition.deleteMany({
      where: {
        code: { in: ['E2E_GEN_SHIFT', 'E2E_NIGHT_SHIFT', 'E2E_SEC_SHIFT'] },
      },
    });
  });

  afterAll(async () => {
    // Cleanup created assignments and shift definitions
    if (prisma) {
      const userIdsToClean = [employeeId, otherEmployeeId].filter(Boolean) as string[];
      if (userIdsToClean.length > 0) {
        await prisma.employeeShiftAssignment.deleteMany({
          where: {
            userId: { in: userIdsToClean },
          },
        });
      }

      await prisma.shiftDefinition.deleteMany({
        where: {
          code: { in: ['E2E_GEN_SHIFT', 'E2E_NIGHT_SHIFT', 'E2E_SEC_SHIFT'] },
        },
      });

      if (newlyCreatedOtherEmpId) {
        await prisma.userSession.deleteMany({ where: { userId: newlyCreatedOtherEmpId } });
        await prisma.userRole.deleteMany({ where: { userId: newlyCreatedOtherEmpId } });
        await prisma.employeeProfile.deleteMany({ where: { userId: newlyCreatedOtherEmpId } });
        await prisma.user.deleteMany({ where: { id: newlyCreatedOtherEmpId } });
      }
    }

    if (app) {
      await app.close();
    }
  });

  describe('1. Shift Definition CRUD & Nested Break Policy Validation', () => {
    it('1.1 should reject shift creation when non-overnight startTime is after endTime (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/shifts')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          code: 'E2E_GEN_SHIFT',
          name: 'General Day Shift',
          startTime: '18:00',
          endTime: '09:00',
          isOvernight: false,
          breakPolicy: {
            paidAllowanceMinutes: 60,
            breakTypes: [{ code: 'LUNCH', maxDurationMinutes: 60 }],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/startTime must be earlier than endTime/i);
    });

    it('1.2 should reject shift creation when halfDayThreshold >= fullDayThreshold (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/shifts')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          code: 'E2E_GEN_SHIFT',
          name: 'General Day Shift',
          startTime: '09:00',
          endTime: '18:00',
          halfDayThresholdMinutes: 500,
          fullDayThresholdMinutes: 480,
          breakPolicy: {
            paidAllowanceMinutes: 60,
            breakTypes: [{ code: 'LUNCH', maxDurationMinutes: 60 }],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/halfDayThresholdMinutes must be strictly less than fullDayThresholdMinutes/i);
    });

    it('1.3 should reject shift creation when break policy contains invalid break types (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/shifts')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          code: 'E2E_GEN_SHIFT',
          name: 'General Day Shift',
          startTime: '09:00',
          endTime: '18:00',
          breakPolicy: {
            paidAllowanceMinutes: 60,
            breakTypes: [{ code: '', maxDurationMinutes: -10 }],
          },
        });

      expect(res.status).toBe(400);
    });

    it('1.4 should successfully create a valid shift definition with nested break policy (201)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/shifts')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          code: 'E2E_GEN_SHIFT',
          name: 'General Day Shift (9 AM - 6 PM)',
          startTime: '09:00',
          endTime: '18:00',
          isOvernight: false,
          gracePeriodMinutes: 15,
          halfDayThresholdMinutes: 240,
          fullDayThresholdMinutes: 480,
          overtimeThresholdMinutes: 540,
          allowMultipleSessions: true,
          autoCloseGraceMinutes: 30,
          breakPolicy: {
            paidAllowanceMinutes: 60,
            breakTypes: [
              { code: 'LUNCH', name: 'Lunch Break', maxDurationMinutes: 60, isPaid: true },
              { code: 'TEA', name: 'Tea Break', maxDurationMinutes: 15, isPaid: true },
            ],
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.code).toBe('E2E_GEN_SHIFT');
      expect(res.body.data.breakPolicy).toBeDefined();
      expect(res.body.data.breakPolicy.paidAllowanceMinutes).toBe(60);
      expect(res.body.data.breakPolicy.breakTypes.length).toBe(2);

      createdShiftId = res.body.data.id;
    });

    it('1.5 should reject duplicate shift code with 409 Conflict', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/shifts')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          code: 'E2E_GEN_SHIFT',
          name: 'Duplicate General Shift',
          startTime: '09:00',
          endTime: '18:00',
          breakPolicy: {
            paidAllowanceMinutes: 60,
            breakTypes: [{ code: 'LUNCH', maxDurationMinutes: 60 }],
          },
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already exists/i);
    });

    it('1.6 should create an overnight shift definition where startTime > endTime and isOvernight: true (201)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/shifts')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          code: 'E2E_NIGHT_SHIFT',
          name: 'Night Shift (10 PM - 6 AM)',
          startTime: '22:00',
          endTime: '06:00',
          isOvernight: true,
          breakPolicy: {
            paidAllowanceMinutes: 45,
            breakTypes: [{ code: 'NIGHT_MEAL', maxDurationMinutes: 45 }],
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.data.isOvernight).toBe(true);
      secondaryShiftId = res.body.data.id;
    });

    it('1.7 should retrieve shift definitions list with search and pagination (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/shifts?search=E2E_GEN_SHIFT')
        .set('Authorization', `Bearer ${employeeToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toBeDefined();
      expect(res.body.data.items.length).toBe(1);
      expect(res.body.data.items[0].code).toBe('E2E_GEN_SHIFT');
      expect(res.body.data.items[0].breakPolicy).toBeDefined();
    });

    it('1.8 should get shift definition by ID (200)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/attendance/shifts/${createdShiftId}`)
        .set('Authorization', `Bearer ${employeeToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(createdShiftId);
      expect(res.body.data.breakPolicy.breakTypes.length).toBe(2);
    });

    it('1.9 should update shift definition details (200)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/attendance/shifts/${createdShiftId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          name: 'Updated General Day Shift',
          gracePeriodMinutes: 20,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Updated General Day Shift');
      expect(res.body.data.gracePeriodMinutes).toBe(20);
    });
  });

  describe('2. Shift Assignment & Mathematical Non-Overlap Validation', () => {
    it('2.1 should reject employee without manage_shifts permission from assigning shifts (403)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/shifts/assign')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          userId: employeeId,
          shiftDefinitionId: createdShiftId,
          startDate: '2026-11-01',
          endDate: '2026-11-15',
        });

      expect(res.status).toBe(403);
    });

    it('2.2 should assign shift to employee for date range [2026-11-01 to 2026-11-15] (201)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/shifts/assign')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          userId: employeeId,
          shiftDefinitionId: createdShiftId,
          startDate: '2026-11-01',
          endDate: '2026-11-15',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.userId).toBe(employeeId);
      expect(res.body.data.shiftDefinitionId).toBe(createdShiftId);

      assignmentId1 = res.body.data.id;
    });

    it('2.3 should reject candidate assignment overlapping with right side: [2026-11-10 to 2026-11-20] (409 Conflict)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/shifts/assign')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          userId: employeeId,
          shiftDefinitionId: secondaryShiftId,
          startDate: '2026-11-10',
          endDate: '2026-11-20',
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/overlaps with existing assignment/i);
    });

    it('2.4 should reject candidate assignment overlapping with left side: [2026-10-25 to 2026-11-05] (409 Conflict)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/shifts/assign')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          userId: employeeId,
          shiftDefinitionId: secondaryShiftId,
          startDate: '2026-10-25',
          endDate: '2026-11-05',
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/overlaps with existing assignment/i);
    });

    it('2.5 should reject candidate assignment completely enclosing existing: [2026-10-20 to 2026-11-30] (409 Conflict)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/shifts/assign')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          userId: employeeId,
          shiftDefinitionId: secondaryShiftId,
          startDate: '2026-10-20',
          endDate: '2026-11-30',
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/overlaps with existing assignment/i);
    });

    it('2.6 should reject candidate open-ended assignment starting within existing range: [2026-11-05 to null] (409 Conflict)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/shifts/assign')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          userId: employeeId,
          shiftDefinitionId: secondaryShiftId,
          startDate: '2026-11-05',
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/overlaps with existing assignment/i);
    });

    it('2.7 should successfully assign adjacent non-overlapping shift: [2026-11-16 to 2026-11-30] (201)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/shifts/assign')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          userId: employeeId,
          shiftDefinitionId: secondaryShiftId,
          startDate: '2026-11-16',
          endDate: '2026-11-30',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      assignmentId2 = res.body.data.id;
    });

    it('2.8 should resolve effective shift for dates within respective intervals', async () => {
      // Date inside first interval (Nov 10)
      const res1 = await request(app.getHttpServer())
        .get(`/api/attendance/shifts/effective/${employeeId}?date=2026-11-10`)
        .set('Authorization', `Bearer ${employeeToken}`);

      expect(res1.status).toBe(200);
      expect(res1.body.data).toBeDefined();
      expect(res1.body.data.shiftDefinition.code).toBe('E2E_GEN_SHIFT');

      // Date inside second interval (Nov 20)
      const res2 = await request(app.getHttpServer())
        .get(`/api/attendance/shifts/effective/${employeeId}?date=2026-11-20`)
        .set('Authorization', `Bearer ${employeeToken}`);

      expect(res2.status).toBe(200);
      expect(res2.body.data).toBeDefined();
      expect(res2.body.data.shiftDefinition.code).toBe('E2E_NIGHT_SHIFT');

      // Date outside any interval (Dec 15)
      const res3 = await request(app.getHttpServer())
        .get(`/api/attendance/shifts/effective/${employeeId}?date=2026-12-15`)
        .set('Authorization', `Bearer ${employeeToken}`);

      expect(res3.status).toBe(200);
      expect(res3.body.data).toBeNull();
    });
  });

  describe('3. Employee Data Scope & Self-View Permissions', () => {
    it('3.1 should allow employee to view their own shift assignments via /my-assignments (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/shifts/my-assignments')
        .set('Authorization', `Bearer ${employeeToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(2);
      expect(res.body.data[0].userId).toBe(employeeId);
    });

    it('3.2 should forbid employee with OWN scope from viewing another employee’s assignments (403)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/attendance/shifts/assignments/${otherEmployeeId}`)
        .set('Authorization', `Bearer ${employeeToken}`);

      expect(res.status).toBe(403);
    });

    it('3.3 should allow Super Admin (DataScope.ALL) to view any employee’s assignments (200)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/attendance/shifts/assignments/${employeeId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(2);
    });
  });

  describe('4. Shift Assignment Updates & Safe Deletion Lifecycle', () => {
    it('4.1 should reject updating assignment if new interval overlaps with another assignment (409 Conflict)', async () => {
      // Try to extend assignment 2 backwards into assignment 1 range (Nov 10)
      const res = await request(app.getHttpServer())
        .patch(`/api/attendance/shifts/assignments/${assignmentId2}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          startDate: '2026-11-10',
          endDate: '2026-11-30',
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/overlaps with existing assignment/i);
    });

    it('4.2 should update assignment date range when no overlap exists (200)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/attendance/shifts/assignments/${assignmentId2}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          startDate: '2026-11-18',
          endDate: '2026-11-28',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(assignmentId2);
    });

    it('4.3 should reject deleting shift definition while assigned to an employee (400)', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/attendance/shifts/${createdShiftId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/currently assigned/i);
    });

    it('4.4 should delete shift assignments (200)', async () => {
      const res1 = await request(app.getHttpServer())
        .delete(`/api/attendance/shifts/assignments/${assignmentId1}`)
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res1.status).toBe(200);

      const res2 = await request(app.getHttpServer())
        .delete(`/api/attendance/shifts/assignments/${assignmentId2}`)
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res2.status).toBe(200);
    });

    it('4.5 should delete unassigned shift definition (200)', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/attendance/shifts/${createdShiftId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);

      const check = await prisma.shiftDefinition.findUnique({
        where: { id: createdShiftId },
      });
      expect(check).toBeNull();
    });
  });
});
