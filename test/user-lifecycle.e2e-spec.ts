import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { RecordStatus } from '../src/generated/prisma/enums';

describe('User Management & Auth Full E2E Lifecycle (e2e)', () => {
  jest.setTimeout(20000);
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminToken: string;
  let superAdminId: string;
  let createdEmployeeId: string;

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

    // Find primary Super Admin in database
    const superAdmin = await prisma.user.findFirst({
      where: {
        userType: { code: 'SUPER_ADMIN' },
        deletedAt: null,
      },
    });

    if (!superAdmin) {
      throw new Error('Super Admin not found in database.');
    }

    superAdminId = superAdmin.id;

    // Ensure email is verified and status is ACTIVE
    await prisma.user.update({
      where: { id: superAdmin.id },
      data: {
        status: RecordStatus.ACTIVE,
        emailVerifiedAt: new Date(),
      },
    });

    const jwtService = app.get(JwtService);
    const session = await prisma.userSession.create({
      data: {
        userId: superAdmin.id,
        refreshTokenHash: 'e2e_refresh_token_hash_' + Date.now(),
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
        sessionId: session.id,
      },
      {
        secret: 'slash@202612354',
        expiresIn: '15m',
      },
    );
  });

  afterAll(async () => {
    // Clean up created employee if any
    if (createdEmployeeId) {
      await prisma.userSession.deleteMany({ where: { userId: createdEmployeeId } });
      await prisma.userRole.deleteMany({ where: { userId: createdEmployeeId } });
      await prisma.userDepartment.deleteMany({ where: { userId: createdEmployeeId } });
      await prisma.userPermission.deleteMany({ where: { userId: createdEmployeeId } });
      await prisma.employeeProfile.deleteMany({ where: { userId: createdEmployeeId } });
      await prisma.user.deleteMany({ where: { id: createdEmployeeId } });
    }
    await app.close();
  });

  describe('1. Unauthenticated and IDOR Protection', () => {
    it('GET /api/users without token should return 401 Unauthorized', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/users')
        .expect(401);
      expect(res.body.success).toBe(false);
    });

    it('GET /api/users/:id with invalid token should return 401 Unauthorized', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/users/${superAdminId}`)
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe('2. Authentication Profile Endpoint', () => {
    it('GET /api/auth/me should return authenticated Super Admin profile and permissions', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(superAdminId);
      expect(res.body.data.userType.code).toBe('SUPER_ADMIN');
      expect(Array.isArray(res.body.data.permissions)).toBe(true);
      expect(res.body.data.permissions.length).toBeGreaterThan(0);
    });
  });

  describe('3. User Creation Lifecycle', () => {
    it('POST /api/users should atomically create an EMPLOYEE with profile and assignments', async () => {
      const uniqueSuffix = Date.now();
      const payload = {
        userType: 'EMPLOYEE',
        name: 'E2E Test Employee',
        email: `e2e_emp_${uniqueSuffix}@slashinfotech.com`,
        phone: `+9198${String(uniqueSuffix).slice(-8)}`,
        roles: ['DEVELOPER'],
        departments: ['DEVELOPMENT'],
        profile: {
          employeeNumber: `EMP_E2E_${uniqueSuffix}`.slice(0, 30),
          designation: 'Senior Backend Engineer',
          employmentType: 'FULL_TIME',
          notes: 'Created via automated E2E test suite',
        },
      };

      const res = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(payload)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.userCode).toMatch(/^EMP\d{3,}$/);
      expect(res.body.data.name).toBe(payload.name);
      expect(res.body.data.email).toBe(payload.email);
      expect(res.body.data.profile.employeeNumber).toBe(payload.profile.employeeNumber);

      createdEmployeeId = res.body.data.id;
    });

    it('POST /api/users should reject duplicate email with 409 Conflict', async () => {
      const existingUser = await prisma.user.findUnique({ where: { id: createdEmployeeId } });
      const payload = {
        userType: 'EMPLOYEE',
        name: 'Duplicate Email Test',
        email: existingUser!.email,
        profile: { designation: 'Dev' },
      };

      const res = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(payload)
        .expect(409);

      expect(res.body.success).toBe(false);
    });

    it('POST /api/users should forbid creating SUPER_ADMIN via ordinary creation', async () => {
      const payload = {
        userType: 'SUPER_ADMIN',
        name: 'Illegal SA',
        email: 'illegal_sa@slash.com',
      };

      const res = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(payload)
        .expect(400);

      expect(res.body.success).toBe(false);
    });
  });

  describe('4. User Listing and Details', () => {
    it('GET /api/users should list non-deleted users with pagination', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/users?page=1&limit=10')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      expect(res.body.data.pagination).toBeDefined();
      expect(res.body.data.pagination.total).toBeGreaterThan(0);
    });

    it('GET /api/users/:id should return complete details of created user', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/users/${createdEmployeeId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(createdEmployeeId);
      expect(res.body.data.profile.designation).toBe('Senior Backend Engineer');
    });
  });

  describe('5. User Updating and Management', () => {
    it('PATCH /api/users/:id should update name and designation', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/users/${createdEmployeeId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          name: 'Updated E2E Employee',
          profile: { designation: 'Lead Backend Engineer' },
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Updated E2E Employee');
      expect(res.body.data.profile.designation).toBe('Lead Backend Engineer');
    });

    it('PUT /api/users/:id/roles should replace user roles', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/users/${createdEmployeeId}/roles`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ roles: ['HR'] })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.roles.some((r: any) => r.code === 'HR')).toBe(true);
    });

    it('PUT /api/users/:id/departments should replace departments with exactly one primary', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/users/${createdEmployeeId}/departments`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          departments: [{ code: 'DEVELOPMENT', isPrimary: true }],
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.departments[0].code).toBe('DEVELOPMENT');
      expect(res.body.data.departments[0].isPrimary).toBe(true);
    });

    it('PUT /api/users/:id/permissions should set direct permission overrides', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/users/${createdEmployeeId}/permissions`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          permissions: [
            {
              code: 'leads.view',
              effect: 'ALLOW',
              dataScope: 'DEPARTMENT',
              reason: 'Department view override',
            },
          ],
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.permissions[0].code).toBe('leads.view');
      expect(res.body.data.permissions[0].effect).toBe('ALLOW');
      expect(res.body.data.permissions[0].dataScope).toBe('DEPARTMENT');
    });

    it('GET /api/users/:id/permissions should resolve effective permissions', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/users/${createdEmployeeId}/permissions`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.permissions)).toBe(true);
      const leadView = res.body.data.permissions.find((p: any) => p.code === 'leads.view');
      expect(leadView).toBeDefined();
      expect(leadView.source).toBe('USER_OVERRIDE');
      expect(leadView.dataScope).toBe('DEPARTMENT');
    });
  });

  describe('6. Status Change, Soft Delete, and Restore Lifecycle', () => {
    it('PATCH /api/users/:id/status should deactivate user and revoke sessions', async () => {
      // Create active session for created user
      await prisma.userSession.create({
        data: {
          userId: createdEmployeeId,
          refreshTokenHash: 'hash_' + Date.now(),
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 60000),
        },
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/users/${createdEmployeeId}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'INACTIVE', reason: 'Testing deactivation' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('INACTIVE');

      const activeSessions = await prisma.userSession.count({
        where: { userId: createdEmployeeId, status: 'ACTIVE' },
      });
      expect(activeSessions).toBe(0);
    });

    it('DELETE /api/users/:id should soft delete user', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/users/${createdEmployeeId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);

      const deleted = await prisma.user.findUnique({
        where: { id: createdEmployeeId },
      });
      expect(deleted!.deletedAt).not.toBeNull();
    });

    it('PATCH /api/users/:id/restore should restore user to ACTIVE status', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/users/${createdEmployeeId}/restore`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('ACTIVE');

      const restored = await prisma.user.findUnique({
        where: { id: createdEmployeeId },
      });
      expect(restored!.deletedAt).toBeNull();
    });
  });
});
