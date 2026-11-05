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
  RecordStatus,
} from '../src/generated/prisma/enums';
import {
  formatDateOnly,
  getAsiaKolkataDateString,
  parseDateOnly,
} from '../src/modules/attendance/attendance.utils';

describe('Phase 6.2.3: Attendance Check-in, Check-out & Break Lifecycle (e2e)', () => {
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

  let singleSessionShiftId: string;
  let multiSessionShiftId: string;
  let overnightShiftId: string;

  const todayStr = getAsiaKolkataDateString(new Date());
  const todayDate = parseDateOnly(todayStr);

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
        refreshTokenHash: 'e2e_sa_623_' + Date.now(),
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

    // 2. Main Test Employee
    let emp = await prisma.user.findFirst({
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
        refreshTokenHash: 'e2e_emp_623_' + Date.now(),
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

    // 3. Second Test Employee
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

    if (!otherEmp || !otherEmp.employeeProfile) {
      const ts = Date.now();
      otherEmp = await prisma.user.create({
        data: {
          userCode: 'EMP_623_' + ts.toString().slice(-4),
          email: `e2e_623_${ts}@slash.test`,
          name: 'Second Test Employee',
          userTypeId: empUserType!.id,
          status: RecordStatus.ACTIVE,
          emailVerifiedAt: new Date(),
          employeeProfile: {
            create: {
              employeeNumber: 'EMP_NUM_623_' + ts.toString().slice(-4),
              designation: 'Backend Engineer',
            },
          },
          userRoles: {
            create: { roleId: devRole!.id },
          },
        },
        include: { employeeProfile: true },
      });
      newlyCreatedOtherEmpId = otherEmp.id;
    }
    otherEmployeeId = otherEmp.id;

    const otherSession = await prisma.userSession.create({
      data: {
        userId: otherEmp.id,
        refreshTokenHash: 'e2e_other_623_' + Date.now(),
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

    // Clean up any test shifts and records
    const userIds = [employeeId, otherEmployeeId];
    await prisma.attendanceBreak.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.attendanceSession.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.attendanceRecord.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.employeeShiftAssignment.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.shiftDefinition.deleteMany({
      where: {
        code: {
          in: ['SHIFT_623_SINGLE', 'SHIFT_623_MULTI', 'SHIFT_623_NIGHT'],
        },
      },
    });

    // Create Test Shift Definitions
    // 1. Single session shift (allowMultipleSessions: false)
    const singleShift = await prisma.shiftDefinition.create({
      data: {
        code: 'SHIFT_623_SINGLE',
        name: 'Single Session Day Shift',
        startTime: '09:00',
        endTime: '18:00',
        isOvernight: false,
        halfDayThresholdMinutes: 240,
        fullDayThresholdMinutes: 480,
        overtimeThresholdMinutes: 540,
        allowMultipleSessions: false,
        breakPolicySnapshot: JSON.stringify({
          paidAllowanceMinutes: 60,
          breakTypes: [
            { code: 'LUNCH', maxDurationMinutes: 60, isPaid: true },
            { code: 'TEA', maxDurationMinutes: 15, isPaid: true },
          ],
        }),
      },
    });
    singleSessionShiftId = singleShift.id;

    // 2. Multi-session shift (allowMultipleSessions: true)
    const multiShift = await prisma.shiftDefinition.create({
      data: {
        code: 'SHIFT_623_MULTI',
        name: 'Multi Session Flexible Shift',
        startTime: '09:00',
        endTime: '18:00',
        isOvernight: false,
        halfDayThresholdMinutes: 240,
        fullDayThresholdMinutes: 480,
        overtimeThresholdMinutes: 540,
        allowMultipleSessions: true,
        breakPolicySnapshot: JSON.stringify({
          paidAllowanceMinutes: 60,
          breakTypes: [
            { code: 'LUNCH', maxDurationMinutes: 60, isPaid: true },
            { code: 'TEA', maxDurationMinutes: 15, isPaid: true },
          ],
        }),
      },
    });
    multiSessionShiftId = multiShift.id;

    // 3. Overnight shift
    const nightShift = await prisma.shiftDefinition.create({
      data: {
        code: 'SHIFT_623_NIGHT',
        name: 'Night Shift (10 PM - 6 AM)',
        startTime: '22:00',
        endTime: '06:00',
        isOvernight: true,
        halfDayThresholdMinutes: 240,
        fullDayThresholdMinutes: 480,
        overtimeThresholdMinutes: 540,
        allowMultipleSessions: false,
        breakPolicySnapshot: JSON.stringify({
          paidAllowanceMinutes: 45,
          breakTypes: [
            { code: 'NIGHT_MEAL', maxDurationMinutes: 45, isPaid: true },
          ],
        }),
      },
    });
    overnightShiftId = nightShift.id;

    // Assign single session shift to main employee
    const empProfile = await prisma.employeeProfile.findUnique({
      where: { userId: employeeId },
    });
    await prisma.employeeShiftAssignment.create({
      data: {
        employeeProfileId: empProfile!.id,
        userId: employeeId,
        shiftDefinitionId: singleSessionShiftId,
        startDate: todayDate,
        endDate: null,
      },
    });

    // Assign multi-session shift to second employee
    const otherProfile = await prisma.employeeProfile.findUnique({
      where: { userId: otherEmployeeId },
    });
    await prisma.employeeShiftAssignment.create({
      data: {
        employeeProfileId: otherProfile!.id,
        userId: otherEmployeeId,
        shiftDefinitionId: multiSessionShiftId,
        startDate: todayDate,
        endDate: null,
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      const userIds = [employeeId, otherEmployeeId].filter(Boolean) as string[];
      await prisma.attendanceBreak.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.attendanceSession.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.attendanceRecord.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.employeeShiftAssignment.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.shiftDefinition.deleteMany({
        where: {
          code: {
            in: ['SHIFT_623_SINGLE', 'SHIFT_623_MULTI', 'SHIFT_623_NIGHT'],
          },
        },
      });

      if (newlyCreatedOtherEmpId) {
        await prisma.userSession.deleteMany({
          where: { userId: newlyCreatedOtherEmpId },
        });
        await prisma.userRole.deleteMany({
          where: { userId: newlyCreatedOtherEmpId },
        });
        await prisma.employeeProfile.deleteMany({
          where: { userId: newlyCreatedOtherEmpId },
        });
        await prisma.user.deleteMany({
          where: { id: newlyCreatedOtherEmpId },
        });
      }
    }

    if (app) {
      await app.close();
    }
  });

  describe('1. Check-in, Check-out & Single-Session Lifecycle', () => {
    it('1.1 should check in successfully for the employee (201 Created)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/check-in')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ location: 'Office Room 101' });

      expect(res.status).toBe(201);
      expect(res.body.data.session).toBeDefined();
      expect(res.body.data.session.status).toBe(AttendanceSessionStatus.ACTIVE);
      expect(res.body.data.session.rawCheckInAt).toBeDefined();
      expect(res.body.data.session.checkInAt).toBeDefined();
      expect(res.body.data.record).toBeDefined();
      expect(res.body.data.record.attendanceDate).toBe(todayStr);

      // Verify record snapshots in database
      const dbRecord = await prisma.attendanceRecord.findUnique({
        where: { id: res.body.data.record.id },
      });
      expect(dbRecord).toBeDefined();
      expect(dbRecord!.allowMultipleSessionsSnapshot).toBe(false);
      expect(dbRecord!.shiftDefinitionId).toBe(singleSessionShiftId);
    });

    it('1.2 should reject duplicate check-in when active session already exists (409 Conflict)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/check-in')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/active attendance session already exists/i);
    });

    it('1.3 should reject direct concurrent database insert of a second active session via MySQL unique generated column', async () => {
      const active = await prisma.attendanceSession.findFirst({
        where: { userId: employeeId, status: AttendanceSessionStatus.ACTIVE },
      });
      expect(active).toBeDefined();

      // Attempt to insert another active session directly into Prisma
      await expect(
        prisma.attendanceSession.create({
          data: {
            attendanceRecordId: active!.attendanceRecordId,
            userId: employeeId,
            rawCheckInAt: new Date(),
            checkInAt: new Date(),
            status: AttendanceSessionStatus.ACTIVE,
          },
        }),
      ).rejects.toThrow();
    });

    it('1.4 should check out successfully and calculate session duration and record totals (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/check-out')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ remarks: 'Finished first shift' });

      expect(res.status).toBe(200);
      expect(res.body.data.session).toBeDefined();
      expect(res.body.data.session.status).toBe(AttendanceSessionStatus.COMPLETED);
      expect(res.body.data.session.checkOutAt).toBeDefined();
      expect(typeof res.body.data.session.durationSeconds).toBe('number');
      expect(res.body.data.record).toBeDefined();
    });

    it('1.5 should reject check-out when no active session exists (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/check-out')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no active attendance session found/i);
    });

    it('1.6 should reject second check-in when shift has allowMultipleSessions: false (409 Conflict)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/check-in')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/multiple attendance sessions are not permitted/i);
    });
  });

  describe('2. Multi-Session Shift Support', () => {
    it('2.1 should allow first session check-in and check-out for employee on multi-session shift (201 -> 200)', async () => {
      // First check-in
      const inRes1 = await request(app.getHttpServer())
        .post('/api/attendance/check-in')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({});
      expect(inRes1.status).toBe(201);

      // First check-out
      const outRes1 = await request(app.getHttpServer())
        .post('/api/attendance/check-out')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({});
      expect(outRes1.status).toBe(200);
      expect(outRes1.body.data.session.status).toBe(AttendanceSessionStatus.COMPLETED);
    });

    it('2.2 should permit second session check-in on the same day when allowMultipleSessions is true (201 Created)', async () => {
      const inRes2 = await request(app.getHttpServer())
        .post('/api/attendance/check-in')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({});

      expect(inRes2.status).toBe(201);
      expect(inRes2.body.data.session.status).toBe(AttendanceSessionStatus.ACTIVE);
    });

    it('2.3 should check out second session and aggregate gross duration across all sessions (200 OK)', async () => {
      const outRes2 = await request(app.getHttpServer())
        .post('/api/attendance/check-out')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({});

      expect(outRes2.status).toBe(200);
      expect(outRes2.body.data.session.status).toBe(AttendanceSessionStatus.COMPLETED);

      // Verify attendance record has 2 sessions
      const sessions = await prisma.attendanceSession.findMany({
        where: { userId: otherEmployeeId },
      });
      expect(sessions.length).toBe(2);
      expect(sessions[0].status).toBe(AttendanceSessionStatus.COMPLETED);
      expect(sessions[1].status).toBe(AttendanceSessionStatus.COMPLETED);
    });
  });

  describe('3. Break Lifecycle & Chronological Allocation', () => {
    let activeBreakId: string;

    it('3.1 should reject starting a break when no active attendance session exists (400 Bad Request)', async () => {
      // Main employee is currently checked out
      const res = await request(app.getHttpServer())
        .post('/api/attendance/breaks/start')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ breakTypeId: 'LUNCH' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/without an active attendance session/i);
    });

    it('3.2 should start a break during an active session (201 Created)', async () => {
      // Start a third session for otherEmployee (multi-session enabled)
      await request(app.getHttpServer())
        .post('/api/attendance/check-in')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({});

      const res = await request(app.getHttpServer())
        .post('/api/attendance/breaks/start')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({ breakTypeId: 'LUNCH', remarks: 'Lunch break' });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.breakTypeId).toBe('LUNCH');
      expect(res.body.data.endedAt).toBeNull();

      activeBreakId = res.body.data.id;
    });

    it('3.3 should reject starting a second concurrent break (409 Conflict)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/breaks/start')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({ breakTypeId: 'TEA' });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already has an active break/i);
    });

    it('3.4 should reject direct concurrent database insert of a second active break via MySQL unique generated column', async () => {
      const active = await prisma.attendanceBreak.findFirst({
        where: { userId: otherEmployeeId, endedAt: null },
      });
      expect(active).toBeDefined();

      await expect(
        prisma.attendanceBreak.create({
          data: {
            attendanceRecordId: active!.attendanceRecordId,
            userId: otherEmployeeId,
            breakTypeId: 'TEA',
            startedAt: new Date(),
            endedAt: null,
            paidDurationSeconds: 0,
            unpaidDurationSeconds: 0,
          },
        }),
      ).rejects.toThrow();
    });

    it('3.5 should reject checking out while a break is active (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/attendance/check-out')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/cannot check out while a break is active/i);
    });

    it('3.6 should reject invalid break type not configured in shift snapshot (400 Bad Request)', async () => {
      // First conclude active break
      await request(app.getHttpServer())
        .post('/api/attendance/breaks/end')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({});

      // Try starting undefined break type
      const res = await request(app.getHttpServer())
        .post('/api/attendance/breaks/start')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({ breakTypeId: 'INVALID_TYPE_XYZ' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid break type/i);
    });

    it('3.7 should end active break and allocate paid vs unpaid duration accurately (200 OK)', async () => {
      // Start another valid break (TEA)
      const startRes = await request(app.getHttpServer())
        .post('/api/attendance/breaks/start')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({ breakTypeId: 'TEA' });
      expect(startRes.status).toBe(201);

      // End break
      const endRes = await request(app.getHttpServer())
        .post('/api/attendance/breaks/end')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({ remarks: 'Back from tea' });

      expect(endRes.status).toBe(200);
      expect(endRes.body.data.break.endedAt).toBeDefined();
      expect(typeof endRes.body.data.break.paidDurationSeconds).toBe('number');
      expect(typeof endRes.body.data.break.unpaidDurationSeconds).toBe('number');

      // Now check out session
      await request(app.getHttpServer())
        .post('/api/attendance/check-out')
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .send({});
    });
  });

  describe('4. Today Status & History API with Data Scopes', () => {
    it('4.1 should retrieve today’s attendance status for authenticated employee (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/today')
        .set('Authorization', `Bearer ${employeeToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.date).toBe(todayStr);
      expect(res.body.data.hasActiveSession).toBe(false);
      expect(res.body.data.record).toBeDefined();
      expect(res.body.data.record.sessions.length).toBe(1);
    });

    it('4.2 should allow employee to retrieve their own attendance history (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/history')
        .set('Authorization', `Bearer ${employeeToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toBeDefined();
      expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.items[0].userId).toBe(employeeId);
    });

    it('4.3 should forbid employee with OWN scope from viewing another employee’s history (403 Forbidden)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/attendance/history?userId=${otherEmployeeId}`)
        .set('Authorization', `Bearer ${employeeToken}`);

      expect(res.status).toBe(403);
    });

    it('4.4 should allow Super Admin (DataScope.ALL) to view any employee’s history (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/attendance/history?userId=${otherEmployeeId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toBeDefined();
      expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.items[0].userId).toBe(otherEmployeeId);
    });
  });
});

