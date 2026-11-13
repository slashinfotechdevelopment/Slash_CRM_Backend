import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { RecordStatus, SessionStatus } from '../src/generated/prisma/enums';

describe('Demo Data & Role-Based API Access Smoke Tests (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  const createdSessionIds: string[] = [];

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
  });

  afterAll(async () => {
    if (createdSessionIds.length > 0) {
      await prisma.userSession.deleteMany({
        where: { id: { in: createdSessionIds } },
      });
    }
    await app.close();
  });

  async function getAuthTokenForUserCode(userCode: string) {
    const user = await prisma.user.findFirstOrThrow({
      where: { userCode },
      include: {
        userType: true,
        userRoles: { include: { role: true } },
      },
    });

    const session = await prisma.userSession.create({
      data: {
        userId: user.id,
        refreshTokenHash: `smoke_test_hash_${Date.now()}_${Math.random()}`,
        status: SessionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours
      },
    });
    createdSessionIds.push(session.id);

    const roleCodes = user.userRoles.map((ur) => ur.role.code);
    const token = await jwtService.signAsync(
      {
        sub: user.id,
        email: user.email,
        userCode: user.userCode,
        userType: user.userType.code,
        roles: roleCodes,
        sessionId: session.id,
      },
      {
        secret: process.env.JWT_SECRET || 'slash@202612354',
        expiresIn: '2h',
      },
    );

    return { user, token };
  }

  // =========================================================================
  // 1. SUPER ADMIN (SA001)
  // =========================================================================
  describe('Super Admin (SA001) Access', () => {
    let token: string;

    beforeAll(async () => {
      const res = await getAuthTokenForUserCode('SA001');
      token = res.token;
    });

    it('should retrieve own profile with SUPER_ADMIN privileges via /api/auth/me', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.userCode).toBe('SA001');
      expect(res.body.data.email).toBe('srihari8489@gmail.com');
      expect(res.body.data.userType.code).toBe('SUPER_ADMIN');
    });

    it('should retrieve all 31 active users across all types and departments via /api/users', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/users?limit=50')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.pagination.total).toBe(31);
      expect(res.body.data.items.length).toBe(31);
    });

    it('should list all tasks across the company via /api/tasks', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks?limit=100')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.meta.total).toBe(50);
      expect(res.body.data.length).toBe(50);
    });

    it('should list all system roles via /api/roles', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/roles')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.pagination.total).toBe(8);
      expect(res.body.data.items.length).toBe(8);
    });
  });

  // =========================================================================
  // 2. ADMIN (A001)
  // =========================================================================
  describe('Admin (A001 - Vikram Singhal) Access', () => {
    let token: string;

    beforeAll(async () => {
      const res = await getAuthTokenForUserCode('A001');
      token = res.token;
    });

    it('should retrieve profile with ADMIN role via /api/auth/me', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.userCode).toBe('A001');
      expect(res.body.data.userType.code).toBe('ADMIN');
      expect(res.body.data.roles.some((r: any) => r.code === 'ADMIN')).toBe(true);
    });

    it('should retrieve users list via /api/users', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/users?limit=50')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 3. PROJECT MANAGER (EMP027)
  // =========================================================================
  describe('Project Manager (EMP027 - Rajesh Sharma) Access', () => {
    let token: string;

    beforeAll(async () => {
      const res = await getAuthTokenForUserCode('EMP027');
      token = res.token;
    });

    it('should retrieve profile with PROJECT_MANAGER role via /api/auth/me', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.userCode).toBe('EMP027');
      expect(res.body.data.roles.some((r: any) => r.code === 'PROJECT_MANAGER')).toBe(true);
    });

    it('should view tasks via /api/tasks', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks?limit=20')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it('should view attendance history via /api/attendance/history', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/history?limit=20')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 4. DEVELOPER (EMP030)
  // =========================================================================
  describe('Developer (EMP030 - Karthik Raman) Access', () => {
    let token: string;

    beforeAll(async () => {
      const res = await getAuthTokenForUserCode('EMP030');
      token = res.token;
    });

    it('should retrieve profile with DEVELOPER role via /api/auth/me', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.userCode).toBe('EMP030');
      expect(res.body.data.roles.some((r: any) => r.code === 'DEVELOPER')).toBe(true);
    });

    it('should see active running timer on TASK252 via /api/tasks/timer/active', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/timer/active')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.isRunning).toBe(true);
      expect(res.body.data.hasActiveTimer).toBe(true);
      expect(res.body.data.task.taskCode).toBe('TASK252');
      expect(res.body.data.entry.status).toBe('RUNNING');
    });

    it('should view assigned tasks via /api/tasks/my-tasks', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/my-tasks')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data.some((t: any) => t.taskCode === 'TASK252')).toBe(true);
    });

    it('should be FORBIDDEN (403) from creating users via /api/users', async () => {
      await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'unauthorized.dev@testslash.com',
          name: 'Unauthorized User',
          phone: '+919999999999',
          userTypeCode: 'EMPLOYEE',
        })
        .expect(403);
    });
  });

  // =========================================================================
  // 5. HR ROLE ACCESS (EMP037 - Sunita Rao)
  // =========================================================================
  describe('HR Role (EMP037 - Sunita Rao) Access', () => {
    let token: string;

    beforeAll(async () => {
      const res = await getAuthTokenForUserCode('EMP037');
      token = res.token;
    });

    it('should retrieve profile with HR role via /api/auth/me', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.userCode).toBe('EMP037');
      expect(res.body.data.roles.some((r: any) => r.code === 'HR')).toBe(true);
    });

    it('should view employee directory via /api/users', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/users?limit=20')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items.length).toBeGreaterThan(0);
    });

    it('should view attendance history via /api/attendance/history', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/history?limit=20')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items.length).toBeGreaterThan(0);
    });

    it('should be FORBIDDEN (403) from creating system roles via /api/roles', async () => {
      await request(app.getHttpServer())
        .post('/api/roles')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: 'UNAUTHORIZED_ROLE', name: 'Unauthorized Role' })
        .expect(403);
    });
  });

  // =========================================================================
  // 6. SALES ROLE ACCESS (EMP040 - Amit Deshmukh)
  // =========================================================================
  describe('Sales Role (EMP040 - Amit Deshmukh) Access', () => {
    let token: string;

    beforeAll(async () => {
      const res = await getAuthTokenForUserCode('EMP040');
      token = res.token;
    });

    it('should retrieve profile with SALES role via /api/auth/me', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.userCode).toBe('EMP040');
      expect(res.body.data.roles.some((r: any) => r.code === 'SALES')).toBe(true);
    });

    it('should be FORBIDDEN (403) from creating users via /api/users', async () => {
      await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'sales.illegal@testslash.com',
          name: 'Sales Illegal User',
          phone: '+919988776655',
          userTypeCode: 'EMPLOYEE',
        })
        .expect(403);
    });

    it('should be FORBIDDEN (403) from creating system roles via /api/roles', async () => {
      await request(app.getHttpServer())
        .post('/api/roles')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: 'SALES_CUSTOM_ROLE', name: 'Sales Custom' })
        .expect(403);
    });
  });

  // =========================================================================
  // 7. ACCOUNTS/FINANCE ROLE ACCESS (EMP043 - Kavita Menon)
  // =========================================================================
  describe('Accounts Role (EMP043 - Kavita Menon) Access', () => {
    let token: string;

    beforeAll(async () => {
      const res = await getAuthTokenForUserCode('EMP043');
      token = res.token;
    });

    it('should retrieve profile with ACCOUNTS role via /api/auth/me', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.userCode).toBe('EMP043');
      expect(res.body.data.roles.some((r: any) => r.code === 'ACCOUNTS')).toBe(true);
    });

    it('should be FORBIDDEN (403) from deleting roles via /api/roles', async () => {
      await request(app.getHttpServer())
        .delete('/api/roles/non-existent-id')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  // =========================================================================
  // 8. SUPPORT ROLE ACCESS (EMP046 - Arjun Pillai)
  // =========================================================================
  describe('Support Role (EMP046 - Arjun Pillai) Access', () => {
    let token: string;

    beforeAll(async () => {
      const res = await getAuthTokenForUserCode('EMP046');
      token = res.token;
    });

    it('should retrieve profile with SUPPORT role via /api/auth/me', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.userCode).toBe('EMP046');
      expect(res.body.data.roles.some((r: any) => r.code === 'SUPPORT')).toBe(true);
    });

    it('should view attendance records via /api/attendance/today', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/today')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('should be FORBIDDEN (403) from creating users via /api/users', async () => {
      await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'support.illegal@testslash.com',
          name: 'Support Illegal User',
          phone: '+919988776644',
          userTypeCode: 'EMPLOYEE',
        })
        .expect(403);
    });
  });

  // =========================================================================
  // 9. EMPLOYEE SELF-SERVICE ACCESS (EMP033 - Priya Sundaram)
  // =========================================================================
  describe('Employee Self-Service Access (EMP033 - Priya Sundaram)', () => {
    let token: string;

    beforeAll(async () => {
      const res = await getAuthTokenForUserCode('EMP033');
      token = res.token;
    });

    it('should retrieve today’s attendance status and shift snapshot via /api/attendance/today', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/attendance/today')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    });

    it('should check active timer status via /api/tasks/timer/active', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/timer/active')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      // Priya has no active running timer today
      expect(res.body.data.isRunning).toBe(false);
    });

    it('should view personal assigned tasks via /api/tasks/my-tasks', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/my-tasks')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    });
  });

  // =========================================================================
  // 10. DEPARTMENT-LEVEL DATA ISOLATION
  // =========================================================================
  describe('Department-Level Data Isolation', () => {
    let devToken: string;

    beforeAll(async () => {
      // EMP030 is in DEVELOPMENT department
      const res = await getAuthTokenForUserCode('EMP030');
      devToken = res.token;
    });

    it('should see development department tasks when querying /api/tasks', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      const tasks = res.body.data;
      expect(tasks.length).toBeGreaterThan(0);
      // All returned tasks must belong to DEVELOPMENT department
      for (const t of tasks) {
        expect(t.department.code).toBe('DEVELOPMENT');
      }
    });
  });

  // =========================================================================
  // 11. CLIENT ISOLATION
  // =========================================================================
  describe('Client (CLI001 - Alok Verma) Access & Isolation', () => {
    let token: string;

    beforeAll(async () => {
      const res = await getAuthTokenForUserCode('CLI001');
      token = res.token;
    });

    it('should retrieve own profile via /api/auth/me with CLIENT user type and 0 internal roles', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.userCode).toBe('CLI001');
      expect(res.body.data.userType.code).toBe('CLIENT');
      expect(res.body.data.roles.length).toBe(0);
    });

    it('should be FORBIDDEN (403) from listing internal CRM users via /api/users', async () => {
      await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('should be FORBIDDEN (403) from accessing internal tasks list via /api/tasks', async () => {
      await request(app.getHttpServer())
        .get('/api/tasks')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('should be FORBIDDEN (403) from accessing system roles via /api/roles', async () => {
      await request(app.getHttpServer())
        .get('/api/roles')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('should be FORBIDDEN (403) from accessing employee attendance via /api/attendance/today', async () => {
      await request(app.getHttpServer())
        .get('/api/attendance/today')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  // =========================================================================
  // 12. INACTIVE TEST USER AUTHENTICATION BLOCK
  // =========================================================================
  describe('Inactive Test User Block (EMP001)', () => {
    it('should reject access (401 Unauthorized) for inactive user', async () => {
      const inactiveUser = await prisma.user.findFirstOrThrow({
        where: { userCode: 'EMP001' },
      });

      expect(inactiveUser.status).toBe(RecordStatus.INACTIVE);

      // Create a temporary session to test guard behavior
      const session = await prisma.userSession.create({
        data: {
          userId: inactiveUser.id,
          refreshTokenHash: `inactive_test_${Date.now()}`,
          status: SessionStatus.ACTIVE,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      createdSessionIds.push(session.id);

      const token = await jwtService.signAsync(
        {
          sub: inactiveUser.id,
          email: inactiveUser.email,
          userCode: inactiveUser.userCode,
          userType: 'EMPLOYEE',
          roles: [],
          sessionId: session.id,
        },
        {
          secret: process.env.JWT_SECRET || 'slash@202612354',
          expiresIn: '1h',
        },
      );

      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });
  });
});
