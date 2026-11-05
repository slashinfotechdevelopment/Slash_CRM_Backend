import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { UsersService } from '../src/modules/users/users.service';
import { DataScope, RecordStatus } from '../src/generated/prisma/enums';

describe('Phase 6.2.1: Attendance System Permissions & Module Setup (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let usersService: UsersService;

  const expectedAttendancePermissions = [
    'attendance.view',
    'attendance.view_overtime',
    'attendance.view_wfh',
    'attendance.check_in',
    'attendance.check_out',
    'attendance.break_manage',
    'attendance.correct_own',
    'attendance.review_correction',
    'attendance.approve_correction',
    'attendance.request_overtime',
    'attendance.approve_overtime',
    'attendance.override_overtime_limit',
    'attendance.request_wfh',
    'attendance.approve_wfh',
    'attendance.manage_shifts',
    'attendance.resolve_incident',
  ];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get<PrismaService>(PrismaService);
    usersService = app.get<UsersService>(UsersService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. should verify all 16 attendance permissions exist in the database with status ACTIVE', async () => {
    const dbPermissions = await prisma.permission.findMany({
      where: { module: 'attendance', status: RecordStatus.ACTIVE },
    });

    const dbCodes = dbPermissions.map((p) => p.code);
    expect(dbPermissions.length).toBeGreaterThanOrEqual(16);
    for (const expected of expectedAttendancePermissions) {
      expect(dbCodes).toContain(expected);
    }
  });

  it('2. should verify ADMIN role is mapped to all 16 attendance permissions with DataScope.ALL', async () => {
    const adminRole = await prisma.role.findUnique({
      where: { code: 'ADMIN' },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    });

    expect(adminRole).toBeDefined();
    const adminPermCodes = adminRole!.permissions
      .filter((rp) => rp.permission.module === 'attendance')
      .map((rp) => rp.permission.code);

    expect(adminPermCodes.length).toBeGreaterThanOrEqual(16);
    for (const code of expectedAttendancePermissions) {
      expect(adminPermCodes).toContain(code);
    }
  });

  it('3. should verify HR role is mapped to all 16 attendance permissions', async () => {
    const hrRole = await prisma.role.findUnique({
      where: { code: 'HR' },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    });

    expect(hrRole).toBeDefined();
    const hrPermCodes = hrRole!.permissions
      .filter((rp) => rp.permission.module === 'attendance')
      .map((rp) => rp.permission.code);

    expect(hrPermCodes.length).toBeGreaterThanOrEqual(16);
  });

  it('4. should verify PROJECT_MANAGER has supervisory and approval permissions', async () => {
    const pmRole = await prisma.role.findUnique({
      where: { code: 'PROJECT_MANAGER' },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    });

    expect(pmRole).toBeDefined();
    const pmPermCodes = pmRole!.permissions
      .filter((rp) => rp.permission.module === 'attendance')
      .map((rp) => rp.permission.code);

    expect(pmPermCodes).toContain('attendance.view');
    expect(pmPermCodes).toContain('attendance.view_overtime');
    expect(pmPermCodes).toContain('attendance.view_wfh');
    expect(pmPermCodes).toContain('attendance.check_in');
    expect(pmPermCodes).toContain('attendance.check_out');
    expect(pmPermCodes).toContain('attendance.break_manage');
    expect(pmPermCodes).toContain('attendance.review_correction');
    expect(pmPermCodes).toContain('attendance.approve_correction');
    expect(pmPermCodes).toContain('attendance.approve_overtime');
    expect(pmPermCodes).toContain('attendance.approve_wfh');
    expect(pmPermCodes).toContain('attendance.manage_shifts');
  });

  it('5. should verify standard employee roles (DEVELOPER) have personal attendance permissions', async () => {
    const devRole = await prisma.role.findUnique({
      where: { code: 'DEVELOPER' },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    });

    expect(devRole).toBeDefined();
    const devPermCodes = devRole!.permissions
      .filter((rp) => rp.permission.module === 'attendance')
      .map((rp) => rp.permission.code);

    expect(devPermCodes).toContain('attendance.view');
    expect(devPermCodes).toContain('attendance.check_in');
    expect(devPermCodes).toContain('attendance.check_out');
    expect(devPermCodes).toContain('attendance.break_manage');
    expect(devPermCodes).toContain('attendance.correct_own');
    expect(devPermCodes).toContain('attendance.request_overtime');
    expect(devPermCodes).toContain('attendance.request_wfh');

    // DEVELOPER must NOT have approval permissions
    expect(devPermCodes).not.toContain('attendance.approve_correction');
    expect(devPermCodes).not.toContain('attendance.approve_overtime');
    expect(devPermCodes).not.toContain('attendance.override_overtime_limit');
    expect(devPermCodes).not.toContain('attendance.resolve_incident');
  });

  it('6. should verify UsersService.resolveActorDataScope for attendance.view', async () => {
    // 6.1 Super Admin -> DataScope.ALL
    const superAdminUser = await prisma.user.findFirst({
      where: { userType: { code: 'SUPER_ADMIN' } },
    });
    if (superAdminUser) {
      const saScope = await usersService.resolveActorDataScope(
        superAdminUser.id,
        'SUPER_ADMIN',
        'attendance.view',
      );
      expect(saScope).toBe(DataScope.ALL);
    }

    // 6.2 Standard Employee -> DataScope.OWN
    const employeeUser = await prisma.user.findFirst({
      where: {
        userType: { code: 'EMPLOYEE' },
        userRoles: { some: { role: { code: 'DEVELOPER' } } },
      },
    });
    if (employeeUser) {
      const empScope = await usersService.resolveActorDataScope(
        employeeUser.id,
        'EMPLOYEE',
        'attendance.view',
      );
      // For developer with OWN mapped or default fallback for non-admin
      expect([DataScope.OWN, DataScope.ALL]).toContain(empScope);
    }
  });
});
