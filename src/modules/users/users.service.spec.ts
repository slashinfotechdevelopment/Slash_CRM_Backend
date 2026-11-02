import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../../database/prisma.service';
import { UserCodeService } from '../../common/services/user-code.service';
import { AuditService } from '../../common/audit/audit.service';
import { OtpService } from '../auth/services/otp.service';
import { RolesService } from '../roles/roles.service';
import { DataScope, RecordStatus } from '../../generated/prisma/enums';

describe('UsersService - Stage 1 & Stage 2', () => {
  let service: UsersService;
  let prisma: any;
  let userCodeService: any;
  let auditService: any;
  let otpService: any;
  let rolesService: any;

  beforeEach(async () => {
    prisma = {
      userType: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      userSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      employeeProfile: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn(),
      },
      clientProfile: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn(),
      },
      media: {
        findFirst: jest.fn(),
      },
      role: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      permission: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      department: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      userRole: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        deleteMany: jest.fn(),
        delete: jest.fn(),
        findUnique: jest.fn(),
      },
      userDepartment: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        deleteMany: jest.fn(),
        delete: jest.fn(),
        findUnique: jest.fn(),
      },
      userPermission: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      $transaction: jest
        .fn()
        .mockImplementation(async (callback) => callback(prisma)),
    };

    userCodeService = {
      generateNextCode: jest.fn(),
    };

    auditService = {
      logAudit: jest.fn().mockResolvedValue(undefined),
      logActivity: jest.fn().mockResolvedValue(undefined),
    };

    otpService = {
      requestOtp: jest.fn().mockResolvedValue({ cooldownSecondsRemaining: 60 }),
    };

    rolesService = {
      getActorEffectivePermissions: jest
        .fn()
        .mockResolvedValue(new Set(['leads.view', 'leads.create'])),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: UserCodeService, useValue: userCodeService },
        { provide: AuditService, useValue: auditService },
        { provide: OtpService, useValue: otpService },
        { provide: RolesService, useValue: rolesService },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  // ==========================================
  // STAGE 1: CREATION TESTS
  // ==========================================
  describe('create - Authorization & User Types', () => {
    it('should reject creation of SUPER_ADMIN through ordinary user CRUD', async () => {
      await expect(
        service.create(
          {
            userType: 'SUPER_ADMIN' as any,
            name: 'New Super Admin',
            email: 'sa2@example.com',
          },
          'sa-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should forbid non-administrators from creating users', async () => {
      await expect(
        service.create(
          {
            userType: 'EMPLOYEE',
            name: 'Employee One',
            email: 'emp1@example.com',
            profile: { designation: 'Developer' },
          },
          'emp-id',
          'EMPLOYEE',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should forbid ADMIN from creating another ADMIN account', async () => {
      await expect(
        service.create(
          {
            userType: 'ADMIN',
            name: 'Admin Two',
            email: 'admin2@example.com',
          },
          'admin-id',
          'ADMIN',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should forbid ADMIN from creating accounts other than EMPLOYEE or CLIENT', async () => {
      await expect(
        service.create(
          {
            userType: 'SUPER_ADMIN' as any,
            name: 'Admin escalation',
            email: 'super@example.com',
          },
          'admin-id',
          'ADMIN',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('create - Super Admin Creates Admin', () => {
    it('should allow Super Admin to create an Admin user with role and without profile', async () => {
      prisma.userType.findFirst.mockResolvedValue({
        id: 'ut-admin',
        code: 'ADMIN',
        status: RecordStatus.ACTIVE,
      });
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'u-admin-1',
          userCode: 'A001',
          name: 'General Admin',
          email: 'admin@example.com',
          phone: null,
          status: 'ACTIVE',
          userType: { id: 'ut-admin', code: 'ADMIN', name: 'Admin' },
          employeeProfile: null,
          clientProfile: null,
          userRoles: [{ role: { id: 'r-admin', code: 'ADMIN', name: 'Admin' } }],
          departments: [],
          createdAt: new Date(),
        });

      userCodeService.generateNextCode.mockResolvedValue('A001');

      prisma.role.findMany.mockResolvedValue([
        {
          id: 'r-admin',
          code: 'ADMIN',
          status: RecordStatus.ACTIVE,
          permissions: [],
        },
      ]);

      prisma.user.create.mockResolvedValue({
        id: 'u-admin-1',
        userCode: 'A001',
        email: 'admin@example.com',
        name: 'General Admin',
      });

      const result = await service.create(
        {
          userType: 'ADMIN',
          name: 'General Admin',
          email: 'admin@example.com',
          roles: ['ADMIN'],
        },
        'sa-id',
        'SUPER_ADMIN',
      );

      expect(result).toBeDefined();
      expect(result?.userCode).toBe('A001');
      expect(userCodeService.generateNextCode).toHaveBeenCalledWith(
        'ADMIN',
        expect.anything(),
      );
      expect(prisma.employeeProfile.create).not.toHaveBeenCalled();
      expect(prisma.clientProfile.create).not.toHaveBeenCalled();
    });

    it('should reject ADMIN creation if profile data is supplied', async () => {
      prisma.userType.findFirst.mockResolvedValue({
        id: 'ut-admin',
        code: 'ADMIN',
        status: RecordStatus.ACTIVE,
      });
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.create(
          {
            userType: 'ADMIN',
            name: 'General Admin',
            email: 'admin@example.com',
            profile: { designation: 'Illegal for admin' },
          },
          'sa-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('create - Super Admin & Admin Create Employee', () => {
    it('should allow Super Admin to create an Employee with employee profile atomically', async () => {
      prisma.userType.findFirst.mockResolvedValue({
        id: 'ut-emp',
        code: 'EMPLOYEE',
        status: RecordStatus.ACTIVE,
      });
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // email check
        .mockResolvedValueOnce(null) // phone check
        .mockResolvedValueOnce({
          // findCreatedUserDetails
          id: 'u-emp-1',
          userCode: 'EMP001',
          name: 'Rahul Kumar',
          email: 'rahul@example.com',
          phone: '+919876543210',
          status: 'ACTIVE',
          userType: { id: 'ut-emp', code: 'EMPLOYEE', name: 'Employee' },
          employeeProfile: {
            employeeNumber: 'EMP1001',
            designation: 'Developer',
          },
          clientProfile: null,
          userRoles: [],
          departments: [],
          createdAt: new Date(),
        });

      prisma.employeeProfile.findUnique.mockResolvedValue(null);
      userCodeService.generateNextCode.mockResolvedValue('EMP001');

      prisma.user.create.mockResolvedValue({
        id: 'u-emp-1',
        userCode: 'EMP001',
        email: 'rahul@example.com',
        name: 'Rahul Kumar',
      });

      const result = await service.create(
        {
          userType: 'EMPLOYEE',
          name: 'Rahul Kumar',
          email: 'rahul@example.com',
          phone: '+919876543210',
          profile: {
            employeeNumber: 'EMP1001',
            designation: 'Developer',
          },
        },
        'sa-id',
        'SUPER_ADMIN',
      );

      expect(result).toBeDefined();
      expect(result?.userCode).toBe('EMP001');
      expect(prisma.employeeProfile.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'u-emp-1',
          employeeNumber: 'EMP1001',
          designation: 'Developer',
        }),
      });
    });

    it('should allow Admin to create an Employee account', async () => {
      prisma.userType.findFirst.mockResolvedValue({
        id: 'ut-emp',
        code: 'EMPLOYEE',
        status: RecordStatus.ACTIVE,
      });
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'u-emp-2',
          userCode: 'EMP002',
          name: 'Suresh',
          email: 'suresh@example.com',
          userType: { code: 'EMPLOYEE' },
          employeeProfile: { designation: 'QA' },
          clientProfile: null,
          userRoles: [],
          departments: [],
        });

      userCodeService.generateNextCode.mockResolvedValue('EMP002');
      prisma.user.create.mockResolvedValue({
        id: 'u-emp-2',
        userCode: 'EMP002',
        email: 'suresh@example.com',
      });

      const result = await service.create(
        {
          userType: 'EMPLOYEE',
          name: 'Suresh',
          email: 'suresh@example.com',
          profile: { designation: 'QA' },
        },
        'admin-id',
        'ADMIN',
      );

      expect(result).toBeDefined();
      expect(result?.userCode).toBe('EMP002');
    });

    it('should reject EMPLOYEE creation when profile is missing', async () => {
      prisma.userType.findFirst.mockResolvedValue({
        id: 'ut-emp',
        code: 'EMPLOYEE',
        status: RecordStatus.ACTIVE,
      });
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.create(
          {
            userType: 'EMPLOYEE',
            name: 'Rahul Kumar',
            email: 'rahul@example.com',
          },
          'sa-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject duplicate employeeNumber', async () => {
      prisma.userType.findFirst.mockResolvedValue({
        id: 'ut-emp',
        code: 'EMPLOYEE',
        status: RecordStatus.ACTIVE,
      });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.employeeProfile.findUnique.mockResolvedValue({
        id: 'ep-existing',
        employeeNumber: 'EMP1001',
      });

      await expect(
        service.create(
          {
            userType: 'EMPLOYEE',
            name: 'Rahul Kumar',
            email: 'rahul@example.com',
            profile: { employeeNumber: 'EMP1001' },
          },
          'sa-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject non-existent reportingToId', async () => {
      prisma.userType.findFirst.mockResolvedValue({
        id: 'ut-emp',
        code: 'EMPLOYEE',
        status: RecordStatus.ACTIVE,
      });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.employeeProfile.findUnique.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.create(
          {
            userType: 'EMPLOYEE',
            name: 'Rahul Kumar',
            email: 'rahul@example.com',
            profile: { reportingToId: 'non-existent-manager' },
          },
          'sa-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('create - Super Admin & Admin Create Client', () => {
    it('should allow Admin to create a Client with ClientProfile atomically', async () => {
      prisma.userType.findFirst.mockResolvedValue({
        id: 'ut-cli',
        code: 'CLIENT',
        status: RecordStatus.ACTIVE,
      });
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'u-cli-1',
          userCode: 'CLI001',
          name: 'Arun Kumar',
          email: 'arun@example.com',
          userType: { code: 'CLIENT' },
          employeeProfile: null,
          clientProfile: { companyName: 'ABC Corp' },
          userRoles: [],
          departments: [],
        });

      userCodeService.generateNextCode.mockResolvedValue('CLI001');
      prisma.user.create.mockResolvedValue({
        id: 'u-cli-1',
        userCode: 'CLI001',
        email: 'arun@example.com',
      });

      const result = await service.create(
        {
          userType: 'CLIENT',
          name: 'Arun Kumar',
          email: 'arun@example.com',
          profile: { companyName: 'ABC Corp', city: 'Coimbatore' },
        },
        'admin-id',
        'ADMIN',
      );

      expect(result).toBeDefined();
      expect(result?.userCode).toBe('CLI001');
      expect(prisma.clientProfile.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'u-cli-1',
          companyName: 'ABC Corp',
          city: 'Coimbatore',
        }),
      });
    });

    it('should reject CLIENT creation if profile or companyName is missing', async () => {
      prisma.userType.findFirst.mockResolvedValue({
        id: 'ut-cli',
        code: 'CLIENT',
        status: RecordStatus.ACTIVE,
      });
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.create(
          {
            userType: 'CLIENT',
            name: 'Arun Kumar',
            email: 'arun@example.com',
          },
          'sa-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject CLIENT creation if logoMediaId is invalid', async () => {
      prisma.userType.findFirst.mockResolvedValue({
        id: 'ut-cli',
        code: 'CLIENT',
        status: RecordStatus.ACTIVE,
      });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.media.findFirst.mockResolvedValue(null);

      await expect(
        service.create(
          {
            userType: 'CLIENT',
            name: 'Arun Kumar',
            email: 'arun@example.com',
            profile: { companyName: 'ABC Corp', logoMediaId: 'bad-media' },
          },
          'sa-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('create - Roles & Delegation Enforcement', () => {
    it('should forbid Admin from assigning SUPER_ADMIN role', async () => {
      prisma.userType.findFirst.mockResolvedValue({
        id: 'ut-emp',
        code: 'EMPLOYEE',
        status: RecordStatus.ACTIVE,
      });
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.create(
          {
            userType: 'EMPLOYEE',
            name: 'Sneaky User',
            email: 'sneaky@example.com',
            roles: ['SUPER_ADMIN'],
            profile: { designation: 'Dev' },
          },
          'admin-id',
          'ADMIN',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should forbid Admin from assigning roles containing permissions they do not possess', async () => {
      prisma.userType.findFirst.mockResolvedValue({
        id: 'ut-emp',
        code: 'EMPLOYEE',
        status: RecordStatus.ACTIVE,
      });
      prisma.user.findUnique.mockResolvedValue(null);

      prisma.role.findMany.mockResolvedValue([
        {
          id: 'r-sys',
          code: 'SYSTEM_SETTINGS',
          status: RecordStatus.ACTIVE,
          permissions: [
            {
              permission: {
                code: 'settings.update',
                status: RecordStatus.ACTIVE,
              },
            },
          ],
        },
      ]);

      rolesService.getActorEffectivePermissions.mockResolvedValue(
        new Set(['leads.view', 'leads.create']),
      );

      await expect(
        service.create(
          {
            userType: 'EMPLOYEE',
            name: 'Employee Target',
            email: 'target@example.com',
            roles: ['SYSTEM_SETTINGS'],
            profile: { designation: 'Dev' },
          },
          'admin-id',
          'ADMIN',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('create - Duplicate Email & Phone', () => {
    it('should reject duplicate email with ConflictException', async () => {
      prisma.userType.findFirst.mockResolvedValue({
        id: 'ut-emp',
        code: 'EMPLOYEE',
        status: RecordStatus.ACTIVE,
      });
      prisma.user.findUnique.mockResolvedValue({ id: 'u-dup' });

      await expect(
        service.create(
          {
            userType: 'EMPLOYEE',
            name: 'Duplicate User',
            email: 'duplicate@example.com',
            profile: { designation: 'Dev' },
          },
          'sa-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject duplicate phone with ConflictException', async () => {
      prisma.userType.findFirst.mockResolvedValue({
        id: 'ut-emp',
        code: 'EMPLOYEE',
        status: RecordStatus.ACTIVE,
      });
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'u-phone-dup' });

      await expect(
        service.create(
          {
            userType: 'EMPLOYEE',
            name: 'Phone Duplicate',
            email: 'newphone@example.com',
            phone: '+919876543210',
            profile: { designation: 'Dev' },
          },
          'sa-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ==========================================
  // STAGE 2: LISTING & DATA SCOPE TESTS
  // ==========================================
  describe('findAll - Listing & Data Scope', () => {
    it('should allow Super Admin to list users without restricting super admins', async () => {
      prisma.user.count.mockResolvedValue(2);
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'u1',
          userCode: 'SA001',
          name: 'Super Admin',
          email: 'sa@example.com',
          phone: null,
          userType: { code: 'SUPER_ADMIN', name: 'Super Admin' },
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
          profileMedia: null,
          userRoles: [],
          departments: [],
          createdAt: new Date(),
        },
      ]);

      const result = await service.findAll(
        { page: 1, limit: 10 },
        'sa-id',
        'SUPER_ADMIN',
      );

      expect(result.items).toHaveLength(1);
      expect(result.pagination.total).toBe(2);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { deletedAt: null }, // Super admin only checks deletedAt: null
            ],
          },
        }),
      );
    });

    it('should enforce that Admin queries exclude SUPER_ADMIN accounts in database where condition', async () => {
      prisma.user.count.mockResolvedValue(1);
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'u-emp',
          userCode: 'EMP001',
          name: 'Employee One',
          email: 'emp@example.com',
          phone: null,
          userType: { code: 'EMPLOYEE', name: 'Employee' },
          status: 'ACTIVE',
          emailVerifiedAt: null,
          profileMedia: null,
          userRoles: [],
          departments: [],
          createdAt: new Date(),
        },
      ]);

      await service.findAll({ page: 1, limit: 10 }, 'admin-id', 'ADMIN');

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              expect.objectContaining({
                userType: { code: { not: 'SUPER_ADMIN' } },
              }),
            ]),
          },
        }),
      );
    });

    it('should resolve data scope per specific permission (e.g. leads.view = ALL vs users.view = OWN without combining)', async () => {
      // User has a role that has leads.view with ALL, but users.view with OWN
      prisma.userRole.findMany.mockImplementation(({ include }: any) => {
        const permCode =
          include?.role?.include?.permissions?.where?.permission?.code;
        return Promise.resolve([
          {
            role: {
              permissions: [
                {
                  permission: {
                    code: 'leads.view',
                    status: RecordStatus.ACTIVE,
                  },
                  dataScope: DataScope.ALL,
                },
                {
                  permission: {
                    code: 'users.view',
                    status: RecordStatus.ACTIVE,
                  },
                  dataScope: DataScope.OWN,
                },
              ].filter((p) => p.permission.code === permCode),
            },
          },
        ]);
      });

      const leadsScope = await service.resolveActorDataScope(
        'emp-id',
        'EMPLOYEE',
        'leads.view',
      );
      const usersScope = await service.resolveActorDataScope(
        'emp-id',
        'EMPLOYEE',
        'users.view',
      );

      expect(leadsScope).toBe(DataScope.ALL);
      expect(usersScope).toBe(DataScope.OWN);
    });

    it('should enforce ASSIGNED data scope semantics (reporting subordinates + self)', async () => {
      // User with ASSIGNED scope for users.view
      prisma.userRole.findMany.mockResolvedValue([
        {
          role: {
            permissions: [
              {
                permission: { code: 'users.view', status: RecordStatus.ACTIVE },
                dataScope: DataScope.ASSIGNED,
              },
            ],
          },
        },
      ]);

      prisma.user.count.mockResolvedValue(1);
      prisma.user.findMany.mockResolvedValue([]);

      await service.findAll({}, 'manager-id', 'EMPLOYEE');

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              expect.objectContaining({
                OR: [
                  { id: 'manager-id' },
                  { employeeProfile: { reportingToId: 'manager-id' } },
                ],
              }),
            ]),
          },
        }),
      );
    });

    it('should restrict CLIENT users to only their own record in database where condition', async () => {
      prisma.user.count.mockResolvedValue(1);
      prisma.user.findMany.mockResolvedValue([]);

      await service.findAll({}, 'client-123', 'CLIENT');

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { id: 'client-123', deletedAt: null },
            ]),
          },
        }),
      );
    });

    it('should reject createdFrom greater than createdTo with BadRequestException', async () => {
      await expect(
        service.findAll(
          {
            createdFrom: '2026-11-10',
            createdTo: '2026-11-01',
          },
          'sa-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should correctly apply search, status, and role filters', async () => {
      prisma.user.count.mockResolvedValue(1);
      prisma.user.findMany.mockResolvedValue([]);

      await service.findAll(
        {
          search: 'rahul',
          status: RecordStatus.ACTIVE,
          role: 'DEVELOPER',
        },
        'sa-id',
        'SUPER_ADMIN',
      );

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              expect.objectContaining({
                OR: [
                  { name: { contains: 'rahul' } },
                  { email: { contains: 'rahul' } },
                  { userCode: { contains: 'rahul' } },
                ],
              }),
              { status: RecordStatus.ACTIVE },
              expect.objectContaining({
                userRoles: {
                  some: {
                    OR: [{ roleId: 'DEVELOPER' }, { role: { code: 'DEVELOPER' } }],
                  },
                },
              }),
            ]),
          },
        }),
      );
    });
  });

  // ==========================================
  // STAGE 2: USER DETAILS TESTS
  // ==========================================
  describe('findOne - User Details Endpoint', () => {
    it('should return complete user details including profiles, roles, and departments', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-emp-10',
        userCode: 'EMP010',
        name: 'Developer One',
        email: 'dev@example.com',
        phone: '+919876543210',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        userType: { id: 'ut-1', code: 'EMPLOYEE', name: 'Employee' },
        profileMedia: null,
        employeeProfile: {
          employeeNumber: 'EMP1010',
          designation: 'Frontend Engineer',
          reportingToId: null,
        },
        clientProfile: null,
        userRoles: [
          { role: { id: 'r1', code: 'DEVELOPER', name: 'Developer' } },
        ],
        departments: [
          {
            department: {
              id: 'd1',
              code: 'DEVELOPMENT',
              name: 'Development',
            },
            isPrimary: true,
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const user = await service.findOne('u-emp-10', 'sa-id', 'SUPER_ADMIN');

      expect(user).toBeDefined();
      expect(user.userCode).toBe('EMP010');
      expect(user.profile.designation).toBe('Frontend Engineer');
      expect(user.roles).toHaveLength(1);
      expect(user.departments).toHaveLength(1);
      expect(user.emailVerified).toBe(true);
    });

    it('should return 404 for deleted or non-existent user IDs', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.findOne('non-existent-id', 'sa-id', 'SUPER_ADMIN'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should prevent ordinary Admin from accessing Super Admin account details (returns 404)', async () => {
      // If user is Super Admin
      prisma.user.findFirst.mockResolvedValue({
        id: 'sa-target',
        userType: { code: 'SUPER_ADMIN' },
      });

      await expect(
        service.findOne('sa-target', 'admin-id', 'ADMIN'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ==========================================
  // STAGE 2: USER UPDATE TESTS
  // ==========================================
  describe('update - Permitted Partial Updates', () => {
    it('should update common user fields (name, phone) and record audit log', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-up-1',
        name: 'Old Name',
        phone: '+919876543210',
        userType: { code: 'EMPLOYEE' },
        employeeProfile: { designation: 'Dev' },
      });

      prisma.user.findUnique.mockResolvedValue(null); // phone uniqueness check
      prisma.user.update.mockResolvedValue({ id: 'u-up-1' });

      // Mock findOne for response
      prisma.user.findFirst.mockResolvedValueOnce({
        id: 'u-up-1',
        name: 'New Name',
        phone: '+919876543211',
        userType: { code: 'EMPLOYEE' },
        employeeProfile: { designation: 'Dev' },
        userRoles: [],
        departments: [],
      });

      const result = await service.update(
        'u-up-1',
        {
          name: 'New Name',
          phone: '+919876543211',
        },
        'sa-id',
        'SUPER_ADMIN',
      );

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-up-1' },
        data: expect.objectContaining({
          name: 'New Name',
          phone: '+919876543211',
          updatedBy: 'sa-id',
        }),
      });
      expect(auditService.logAudit).toHaveBeenCalled();
    });

    it('should update employee profile fields atomically', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-emp-up',
        userType: { code: 'EMPLOYEE' },
        employeeProfile: { employeeNumber: 'EMP100', designation: 'Junior Dev' },
      });

      prisma.employeeProfile.upsert.mockResolvedValue({});

      // Mock findOne return
      prisma.user.findFirst.mockResolvedValueOnce({
        id: 'u-emp-up',
        userType: { code: 'EMPLOYEE' },
        employeeProfile: { designation: 'Senior Dev' },
        userRoles: [],
        departments: [],
      });

      await service.update(
        'u-emp-up',
        {
          profile: {
            designation: 'Senior Dev',
            notes: 'Promoted',
          },
        },
        'sa-id',
        'SUPER_ADMIN',
      );

      expect(prisma.employeeProfile.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u-emp-up' },
          update: expect.objectContaining({
            designation: 'Senior Dev',
            notes: 'Promoted',
          }),
        }),
      );
    });

    it('should reject duplicate employee number on update', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-emp-up',
        userType: { code: 'EMPLOYEE' },
        employeeProfile: { employeeNumber: 'EMP100' },
      });

      prisma.employeeProfile.findFirst.mockResolvedValue({
        id: 'other-emp',
        userId: 'other-user',
        employeeNumber: 'EMP999',
      });

      await expect(
        service.update(
          'u-emp-up',
          {
            profile: {
              employeeNumber: 'EMP999',
            },
          },
          'sa-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject self-reporting relationship (reportingToId === id)', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-self',
        userType: { code: 'EMPLOYEE' },
        employeeProfile: {},
      });

      await expect(
        service.update(
          'u-self',
          {
            profile: {
              reportingToId: 'u-self',
            },
          },
          'sa-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should forbid Admin from modifying Super Admin account', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'sa-target',
        userType: { code: 'SUPER_ADMIN' },
      });

      await expect(
        service.update(
          'sa-target',
          { name: 'Hacked Super Admin' },
          'admin-id',
          'ADMIN',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject profile updates incompatible with user type (e.g. profile for ADMIN)', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'admin-target',
        userType: { code: 'ADMIN' },
      });

      await expect(
        service.update(
          'admin-target',
          { profile: { companyName: 'Illegal' } },
          'sa-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ==========================================
  // STAGE 3: STATUS MANAGEMENT & DEACTIVATION
  // ==========================================
  describe('updateStatus - Account Activation / Deactivation', () => {
    it('should allow Super Admin to deactivate an Employee and revoke active sessions', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({
        id: 'u-emp-1',
        status: RecordStatus.ACTIVE,
        userType: { code: 'EMPLOYEE' },
      });

      prisma.user.findFirst.mockResolvedValueOnce({
        id: 'u-emp-1',
        status: RecordStatus.INACTIVE,
        userType: { code: 'EMPLOYEE' },
        userRoles: [],
        departments: [],
      });

      await service.updateStatus(
        'u-emp-1',
        { status: RecordStatus.INACTIVE, reason: 'Employee left company' },
        'sa-id',
        'SUPER_ADMIN',
      );

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-emp-1' },
        data: expect.objectContaining({
          status: RecordStatus.INACTIVE,
          updatedBy: 'sa-id',
        }),
      });

      expect(prisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u-emp-1', status: 'ACTIVE' },
        data: expect.objectContaining({
          status: 'REVOKED',
          revokedAt: expect.any(Date),
        }),
      });

      expect(auditService.logAudit).toHaveBeenCalled();
    });

    it('should allow Super Admin to deactivate an Admin user', async () => {
      prisma.user.findFirst.mockResolvedValueOnce({
        id: 'u-admin-1',
        status: RecordStatus.ACTIVE,
        userType: { code: 'ADMIN' },
      });

      prisma.user.findFirst.mockResolvedValueOnce({
        id: 'u-admin-1',
        status: RecordStatus.INACTIVE,
        userType: { code: 'ADMIN' },
        userRoles: [],
        departments: [],
      });

      await service.updateStatus(
        'u-admin-1',
        { status: RecordStatus.INACTIVE },
        'sa-id',
        'SUPER_ADMIN',
      );

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'u-admin-1' },
          data: expect.objectContaining({ status: RecordStatus.INACTIVE }),
        }),
      );
    });

    it('should forbid Admin from changing Super Admin status', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'sa-target',
        status: RecordStatus.ACTIVE,
        userType: { code: 'SUPER_ADMIN' },
      });

      await expect(
        service.updateStatus(
          'sa-target',
          { status: RecordStatus.INACTIVE },
          'admin-id',
          'ADMIN',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject self-deactivation', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'self-id',
        status: RecordStatus.ACTIVE,
        userType: { code: 'EMPLOYEE' },
      });

      await expect(
        service.updateStatus(
          'self-id',
          { status: RecordStatus.INACTIVE },
          'self-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject redundant status transition (e.g. already ACTIVE)', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-emp-1',
        status: RecordStatus.ACTIVE,
        userType: { code: 'EMPLOYEE' },
      });

      await expect(
        service.updateStatus(
          'u-emp-1',
          { status: RecordStatus.ACTIVE },
          'sa-id',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should prevent deactivating the last active Super Admin account', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'sa-1',
        status: RecordStatus.ACTIVE,
        userType: { code: 'SUPER_ADMIN' },
      });

      prisma.user.count.mockResolvedValue(1);

      await expect(
        service.updateStatus(
          'sa-1',
          { status: RecordStatus.INACTIVE },
          'sa-id-different',
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ==========================================
  // STAGE 3: SOFT DELETION TESTS
  // ==========================================
  describe('remove - Soft Deletion', () => {
    it('should soft-delete an eligible user, deactivate them, and revoke active sessions', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-emp-del',
        name: 'Del User',
        userCode: 'EMP099',
        deletedAt: null,
        status: RecordStatus.ACTIVE,
        userType: { code: 'EMPLOYEE' },
      });

      const result = await service.remove(
        'u-emp-del',
        'sa-id',
        'SUPER_ADMIN',
      );

      expect(result.message).toBe('User deleted successfully.');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-emp-del' },
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
          deletedBy: 'sa-id',
          status: RecordStatus.INACTIVE,
        }),
      });

      expect(prisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u-emp-del', status: 'ACTIVE' },
        data: expect.objectContaining({
          status: 'REVOKED',
          revokedAt: expect.any(Date),
        }),
      });

      expect(auditService.logAudit).toHaveBeenCalled();
    });

    it('should forbid Admin from deleting Super Admin account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'sa-target',
        deletedAt: null,
        userType: { code: 'SUPER_ADMIN' },
      });

      await expect(
        service.remove('sa-target', 'admin-id', 'ADMIN'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject self-deletion', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'sa-self',
        deletedAt: null,
        userType: { code: 'SUPER_ADMIN' },
      });

      await expect(
        service.remove('sa-self', 'sa-self', 'SUPER_ADMIN'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should prevent deleting the last active Super Admin', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'sa-1',
        deletedAt: null,
        userType: { code: 'SUPER_ADMIN' },
      });

      prisma.user.count.mockResolvedValue(1);

      await expect(
        service.remove('sa-1', 'sa-different', 'SUPER_ADMIN'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject duplicate deletion (already soft-deleted)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'already-del',
        deletedAt: new Date(),
        userType: { code: 'EMPLOYEE' },
      });

      await expect(
        service.remove('already-del', 'sa-id', 'SUPER_ADMIN'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ==========================================
  // STAGE 3: USER RESTORATION TESTS
  // ==========================================
  describe('restore - User Restoration', () => {
    it('should restore a soft-deleted user and clear deletedAt / deletedBy', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-restorable',
        email: 'restorable@example.com',
        phone: '+919876543299',
        deletedAt: new Date(),
        deletedBy: 'sa-id',
        status: RecordStatus.INACTIVE,
        userType: { code: 'EMPLOYEE' },
        employeeProfile: null,
        clientProfile: null,
      });

      prisma.user.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      prisma.user.findFirst.mockResolvedValueOnce({
        id: 'u-restorable',
        email: 'restorable@example.com',
        deletedAt: null,
        status: RecordStatus.ACTIVE,
        userType: { code: 'EMPLOYEE' },
        userRoles: [],
        departments: [],
      });

      await service.restore(
        'u-restorable',
        'sa-id',
        'SUPER_ADMIN',
      );

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-restorable' },
        data: expect.objectContaining({
          deletedAt: null,
          deletedBy: null,
          updatedBy: 'sa-id',
          status: RecordStatus.ACTIVE,
        }),
      });

      expect(auditService.logAudit).toHaveBeenCalled();
    });

    it('should reject restoration of an active non-deleted user', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'active-user',
        deletedAt: null,
        userType: { code: 'EMPLOYEE' },
      });

      await expect(
        service.restore('active-user', 'sa-id', 'SUPER_ADMIN'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should forbid Admin from restoring a Super Admin account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'sa-deleted',
        deletedAt: new Date(),
        userType: { code: 'SUPER_ADMIN' },
      });

      await expect(
        service.restore('sa-deleted', 'admin-id', 'ADMIN'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject restoration if email is in use by another active user (HTTP 409)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-email-conflict',
        email: 'taken@example.com',
        deletedAt: new Date(),
        userType: { code: 'EMPLOYEE' },
      });

      prisma.user.findFirst.mockResolvedValue({
        id: 'other-user',
        email: 'taken@example.com',
      });

      await expect(
        service.restore('u-email-conflict', 'sa-id', 'SUPER_ADMIN'),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject restoration if employeeNumber is in use by another active employee (HTTP 409)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-emp-conflict',
        email: 'valid@example.com',
        deletedAt: new Date(),
        userType: { code: 'EMPLOYEE' },
        employeeProfile: { employeeNumber: 'EMP777' },
      });

      prisma.user.findFirst.mockResolvedValue(null);
      prisma.employeeProfile.findFirst.mockResolvedValue({
        id: 'ep-conflict',
        employeeNumber: 'EMP777',
      });

      await expect(
        service.restore('u-emp-conflict', 'sa-id', 'SUPER_ADMIN'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('Stage 4 - Role Assignment Management', () => {
    describe('replaceRoles', () => {
      it('should allow Super Admin to replace user roles successfully', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.role.findMany.mockResolvedValue([
          {
            id: 'r-dev',
            code: 'DEVELOPER',
            name: 'Developer',
            permissions: [],
          },
        ]);
        prisma.userRole.findMany.mockResolvedValue([]);

        const result = await service.replaceRoles(
          'u-target',
          { roles: ['DEVELOPER'] },
          'sa-id',
          'SUPER_ADMIN',
        );

        expect(result.userId).toBe('u-target');
        expect(result.roles).toHaveLength(1);
        expect(result.roles[0].code).toBe('DEVELOPER');
        expect(auditService.logAudit).toHaveBeenCalled();
      });

      it('should throw NotFoundException if target user not found', async () => {
        prisma.user.findFirst.mockResolvedValue(null);

        await expect(
          service.replaceRoles(
            'u-nonexistent',
            { roles: ['DEVELOPER'] },
            'sa-id',
            'SUPER_ADMIN',
          ),
        ).rejects.toThrow(NotFoundException);
      });

      it('should throw ForbiddenException if Admin tries to modify Super Admin roles', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-sa',
          userType: { code: 'SUPER_ADMIN' },
        });

        await expect(
          service.replaceRoles(
            'u-sa',
            { roles: ['DEVELOPER'] },
            'admin-id',
            'ADMIN',
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should throw ForbiddenException if non-admin tries to modify roles', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });

        await expect(
          service.replaceRoles(
            'u-target',
            { roles: ['DEVELOPER'] },
            'emp-id',
            'EMPLOYEE',
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should throw ForbiddenException on self-role modification by non-super-admin', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'admin-id',
          userType: { code: 'ADMIN' },
        });

        await expect(
          service.replaceRoles(
            'admin-id',
            { roles: ['DEVELOPER'] },
            'admin-id',
            'ADMIN',
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should throw BadRequestException if any specified role is invalid or not found', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.role.findMany.mockResolvedValue([]); // Role not found

        await expect(
          service.replaceRoles(
            'u-target',
            { roles: ['NONEXISTENT_ROLE'] },
            'sa-id',
            'SUPER_ADMIN',
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('should throw ForbiddenException if attempting to assign SUPER_ADMIN role', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.role.findMany.mockResolvedValue([
          {
            id: 'r-sa',
            code: 'SUPER_ADMIN',
            name: 'Super Admin',
            permissions: [],
          },
        ]);

        await expect(
          service.replaceRoles(
            'u-target',
            { roles: ['SUPER_ADMIN'] },
            'sa-id',
            'SUPER_ADMIN',
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should throw ForbiddenException if Admin assigns a role containing permissions outside their authority', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.role.findMany.mockResolvedValue([
          {
            id: 'r-pm',
            code: 'PROJECT_MANAGER',
            name: 'Project Manager',
            permissions: [
              {
                permission: {
                  code: 'audit_logs.view',
                  status: RecordStatus.ACTIVE,
                },
              },
            ],
          },
        ]);
        rolesService.getActorEffectivePermissions.mockResolvedValue(
          new Set(['users.view', 'leads.view']),
        );

        await expect(
          service.replaceRoles(
            'u-target',
            { roles: ['PROJECT_MANAGER'] },
            'admin-id',
            'ADMIN',
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should allow Admin to assign role if they possess all role permissions', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.role.findMany.mockResolvedValue([
          {
            id: 'r-sales',
            code: 'SALES',
            name: 'Sales',
            permissions: [
              {
                permission: {
                  code: 'leads.view',
                  status: RecordStatus.ACTIVE,
                },
              },
            ],
          },
        ]);
        rolesService.getActorEffectivePermissions.mockResolvedValue(
          new Set(['leads.view', 'leads.create']),
        );
        prisma.userRole.findMany.mockResolvedValue([]);

        const result = await service.replaceRoles(
          'u-target',
          { roles: ['SALES'] },
          'admin-id',
          'ADMIN',
        );

        expect(result.userId).toBe('u-target');
        expect(result.roles[0].code).toBe('SALES');
      });
    });

    describe('addRoles', () => {
      it('should add roles to user without removing existing assignments and be idempotent', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.role.findMany.mockResolvedValue([
          {
            id: 'r-dev',
            code: 'DEVELOPER',
            name: 'Developer',
            permissions: [],
          },
          {
            id: 'r-sales',
            code: 'SALES',
            name: 'Sales',
            permissions: [],
          },
        ]);
        // User already has DEVELOPER
        prisma.userRole.findMany
          .mockResolvedValueOnce([{ roleId: 'r-dev' }]) // existingAssignments
          .mockResolvedValueOnce([
            { role: { id: 'r-dev', code: 'DEVELOPER', name: 'Developer' } },
            { role: { id: 'r-sales', code: 'SALES', name: 'Sales' } },
          ]); // updatedUserRoles

        const result = await service.addRoles(
          'u-target',
          { roles: ['DEVELOPER', 'SALES'] },
          'sa-id',
          'SUPER_ADMIN',
        );

        expect(result.roles).toHaveLength(2);
        expect(auditService.logAudit).toHaveBeenCalled();
      });

      it('should throw NotFoundException if target user not found', async () => {
        prisma.user.findFirst.mockResolvedValue(null);

        await expect(
          service.addRoles(
            'u-nonexistent',
            { roles: ['DEVELOPER'] },
            'sa-id',
            'SUPER_ADMIN',
          ),
        ).rejects.toThrow(NotFoundException);
      });

      it('should throw ForbiddenException if Admin tries to add roles to Super Admin', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-sa',
          userType: { code: 'SUPER_ADMIN' },
        });

        await expect(
          service.addRoles(
            'u-sa',
            { roles: ['DEVELOPER'] },
            'admin-id',
            'ADMIN',
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should throw ForbiddenException if Admin lacks delegation authority', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.role.findMany.mockResolvedValue([
          {
            id: 'r-dev',
            code: 'DEVELOPER',
            name: 'Developer',
            permissions: [
              {
                permission: {
                  code: 'settings.update',
                  status: RecordStatus.ACTIVE,
                },
              },
            ],
          },
        ]);
        rolesService.getActorEffectivePermissions.mockResolvedValue(
          new Set(['users.view']),
        );

        await expect(
          service.addRoles(
            'u-target',
            { roles: ['DEVELOPER'] },
            'admin-id',
            'ADMIN',
          ),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    describe('removeRole', () => {
      it('should remove a specific role assignment from a user successfully', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.role.findFirst.mockResolvedValue({
          id: 'r-dev',
          code: 'DEVELOPER',
          name: 'Developer',
        });
        prisma.userRole.findUnique.mockResolvedValue({
          userId: 'u-target',
          roleId: 'r-dev',
        });
        prisma.userRole.delete.mockResolvedValue({});

        const result = await service.removeRole(
          'u-target',
          'DEVELOPER',
          'sa-id',
          'SUPER_ADMIN',
        );

        expect(result.message).toContain('Developer');
        expect(auditService.logAudit).toHaveBeenCalled();
      });

      it('should throw NotFoundException if user not found', async () => {
        prisma.user.findFirst.mockResolvedValue(null);

        await expect(
          service.removeRole(
            'u-nonexistent',
            'DEVELOPER',
            'sa-id',
            'SUPER_ADMIN',
          ),
        ).rejects.toThrow(NotFoundException);
      });

      it('should throw ForbiddenException if Admin tries to remove role from Super Admin', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-sa',
          userType: { code: 'SUPER_ADMIN' },
        });

        await expect(
          service.removeRole(
            'u-sa',
            'DEVELOPER',
            'admin-id',
            'ADMIN',
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should throw ForbiddenException on self-role removal by non-super-admin', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'admin-id',
          userType: { code: 'ADMIN' },
        });

        await expect(
          service.removeRole(
            'admin-id',
            'DEVELOPER',
            'admin-id',
            'ADMIN',
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should throw NotFoundException if role does not exist', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.role.findFirst.mockResolvedValue(null);

        await expect(
          service.removeRole(
            'u-target',
            'NONEXISTENT',
            'sa-id',
            'SUPER_ADMIN',
          ),
        ).rejects.toThrow(NotFoundException);
      });

      it('should throw NotFoundException if role is not assigned to the user', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.role.findFirst.mockResolvedValue({
          id: 'r-dev',
          code: 'DEVELOPER',
          name: 'Developer',
        });
        prisma.userRole.findUnique.mockResolvedValue(null);

        await expect(
          service.removeRole(
            'u-target',
            'DEVELOPER',
            'sa-id',
            'SUPER_ADMIN',
          ),
        ).rejects.toThrow(NotFoundException);
      });
    });
  });

  describe('Stage 4 - Department Assignment Management', () => {
    describe('replaceDepartments', () => {
      it('should replace user departments with exactly one primary department', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.department.findMany.mockResolvedValue([
          {
            id: 'dept-dev',
            code: 'DEVELOPMENT',
            name: 'Development',
          },
          {
            id: 'dept-qa',
            code: 'QA',
            name: 'Quality Assurance',
          },
        ]);
        prisma.userDepartment.findMany.mockResolvedValue([]);

        const result = await service.replaceDepartments(
          'u-target',
          {
            departments: [
              { code: 'DEVELOPMENT', isPrimary: true },
              { code: 'QA', isPrimary: false },
            ],
          },
          'sa-id',
          'SUPER_ADMIN',
        );

        expect(result.departments).toHaveLength(2);
        expect(result.departments[0].isPrimary).toBe(true);
        expect(result.departments[1].isPrimary).toBe(false);
        expect(auditService.logAudit).toHaveBeenCalled();
      });

      it('should allow clearing all departments by providing empty array', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.userDepartment.findMany.mockResolvedValue([]);

        const result = await service.replaceDepartments(
          'u-target',
          { departments: [] },
          'sa-id',
          'SUPER_ADMIN',
        );

        expect(result.departments).toHaveLength(0);
      });

      it('should throw BadRequestException if multiple primary departments are provided', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });

        await expect(
          service.replaceDepartments(
            'u-target',
            {
              departments: [
                { code: 'DEVELOPMENT', isPrimary: true },
                { code: 'QA', isPrimary: true },
              ],
            },
            'sa-id',
            'SUPER_ADMIN',
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('should throw BadRequestException if no primary department is provided when assigning departments', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });

        await expect(
          service.replaceDepartments(
            'u-target',
            {
              departments: [
                { code: 'DEVELOPMENT', isPrimary: false },
                { code: 'QA', isPrimary: false },
              ],
            },
            'sa-id',
            'SUPER_ADMIN',
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('should throw ForbiddenException if Admin tries to modify Super Admin departments', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-sa',
          userType: { code: 'SUPER_ADMIN' },
        });

        await expect(
          service.replaceDepartments(
            'u-sa',
            { departments: [{ code: 'DEVELOPMENT', isPrimary: true }] },
            'admin-id',
            'ADMIN',
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should throw BadRequestException if any department does not exist', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.department.findMany.mockResolvedValue([]); // not found

        await expect(
          service.replaceDepartments(
            'u-target',
            { departments: [{ code: 'UNKNOWN_DEPT', isPrimary: true }] },
            'sa-id',
            'SUPER_ADMIN',
          ),
        ).rejects.toThrow(BadRequestException);
      });
    });
  });

  describe('Stage 4 - Individual Permission Overrides', () => {
    describe('replacePermissions', () => {
      it('should replace permission overrides with ALLOW and DENY effects', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.permission.findMany.mockResolvedValue([
          {
            id: 'p-leads-view',
            code: 'leads.view',
            status: RecordStatus.ACTIVE,
          },
          {
            id: 'p-inv-appr',
            code: 'invoices.approve',
            status: RecordStatus.ACTIVE,
          },
        ]);

        const result = await service.replacePermissions(
          'u-target',
          {
            permissions: [
              {
                code: 'leads.view',
                effect: 'ALLOW' as any,
                dataScope: DataScope.ASSIGNED,
                reason: 'Sales team assignment',
              },
              {
                code: 'invoices.approve',
                effect: 'DENY' as any,
                reason: 'Finance restriction',
              },
            ],
          },
          'sa-id',
          'SUPER_ADMIN',
        );

        expect(result.permissions).toHaveLength(2);
        expect(result.permissions[0].effect).toBe('ALLOW');
        expect(result.permissions[0].dataScope).toBe(DataScope.ASSIGNED);
        expect(result.permissions[1].effect).toBe('DENY');
        expect(result.permissions[1].dataScope).toBeNull();
        expect(auditService.logAudit).toHaveBeenCalled();
      });

      it('should throw ForbiddenException if Admin tries to modify Super Admin permissions', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-sa',
          userType: { code: 'SUPER_ADMIN' },
        });

        await expect(
          service.replacePermissions(
            'u-sa',
            { permissions: [] },
            'admin-id',
            'ADMIN',
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should throw ForbiddenException if non-super-admin tries to modify their own permissions', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'admin-id',
          userType: { code: 'ADMIN' },
        });

        await expect(
          service.replacePermissions(
            'admin-id',
            { permissions: [] },
            'admin-id',
            'ADMIN',
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should throw ForbiddenException if Admin grants ALLOW for a permission they do not possess', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.permission.findMany.mockResolvedValue([
          {
            id: 'p-settings',
            code: 'settings.update',
            status: RecordStatus.ACTIVE,
          },
        ]);
        rolesService.getActorEffectivePermissions.mockResolvedValue(
          new Set(['users.view']),
        );

        await expect(
          service.replacePermissions(
            'u-target',
            {
              permissions: [
                {
                  code: 'settings.update',
                  effect: 'ALLOW' as any,
                },
              ],
            },
            'admin-id',
            'ADMIN',
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('should allow Admin to grant DENY override even for permissions they lack', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userType: { code: 'EMPLOYEE' },
        });
        prisma.permission.findMany.mockResolvedValue([
          {
            id: 'p-settings',
            code: 'settings.update',
            status: RecordStatus.ACTIVE,
          },
        ]);
        rolesService.getActorEffectivePermissions.mockResolvedValue(
          new Set(['users.view']),
        );

        const result = await service.replacePermissions(
          'u-target',
          {
            permissions: [
              {
                code: 'settings.update',
                effect: 'DENY' as any,
                reason: 'Block settings',
              },
            ],
          },
          'admin-id',
          'ADMIN',
        );

        expect(result.permissions[0].effect).toBe('DENY');
      });
    });

    describe('getEffectivePermissions', () => {
      it('should return 0 permissions and empty roles for inactive or soft-deleted user', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-inactive',
          userCode: 'EMP999',
          status: RecordStatus.INACTIVE,
          deletedAt: null,
          userType: { code: 'EMPLOYEE' },
          userRoles: [],
          userPermissions: [],
        });

        const result = await service.getEffectivePermissions(
          'u-inactive',
          'sa-id',
          'SUPER_ADMIN',
        );

        expect(result.permissions).toHaveLength(0);
        expect(result.roles).toHaveLength(0);
      });

      it('should return ALL active permissions for Super Admin account with DataScope.ALL', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-sa',
          userCode: 'SA001',
          status: RecordStatus.ACTIVE,
          deletedAt: null,
          userType: { code: 'SUPER_ADMIN' },
          userRoles: [],
          userPermissions: [],
        });
        prisma.permission.findMany.mockResolvedValue([
          {
            code: 'users.create',
            name: 'Create User',
            module: 'users',
            action: 'create',
          },
          {
            code: 'leads.view',
            name: 'View Leads',
            module: 'leads',
            action: 'view',
          },
        ]);

        const result = await service.getEffectivePermissions(
          'u-sa',
          'sa-id',
          'SUPER_ADMIN',
        );

        expect(result.roles).toContain('SUPER_ADMIN');
        expect(result.permissions).toHaveLength(2);
        expect(result.permissions[0].dataScope).toBe(DataScope.ALL);
        expect(result.permissions[0].source).toBe('SYSTEM');
      });

      it('should hide Super Admin accounts from ordinary Admin (404 Not Found)', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-sa',
          userCode: 'SA001',
          status: RecordStatus.ACTIVE,
          deletedAt: null,
          userType: { code: 'SUPER_ADMIN' },
        });

        await expect(
          service.getEffectivePermissions(
            'u-sa',
            'admin-id',
            'ADMIN',
          ),
        ).rejects.toThrow(NotFoundException);
      });

      it('should enforce 5-tier precedence: direct DENY overrides role ALLOW', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userCode: 'EMP001',
          status: RecordStatus.ACTIVE,
          deletedAt: null,
          userType: { code: 'EMPLOYEE' },
          userPermissions: [
            {
              effect: 'DENY',
              reason: 'Restricted for audit',
              permission: {
                code: 'leads.view',
                name: 'View Leads',
                module: 'leads',
                action: 'view',
                status: RecordStatus.ACTIVE,
              },
            },
          ],
          userRoles: [
            {
              role: {
                code: 'SALES',
                status: RecordStatus.ACTIVE,
                deletedAt: null,
                permissions: [
                  {
                    dataScope: DataScope.ALL,
                    permission: {
                      code: 'leads.view',
                      name: 'View Leads',
                      module: 'leads',
                      action: 'view',
                      status: RecordStatus.ACTIVE,
                    },
                  },
                ],
              },
            },
          ],
        });

        const result = await service.getEffectivePermissions(
          'u-target',
          'sa-id',
          'SUPER_ADMIN',
        );

        const leadsPerm = result.permissions.find(
          (p) => p.code === 'leads.view',
        );
        expect(leadsPerm).toBeDefined();
        expect(leadsPerm?.effect).toBe('DENY');
        expect(leadsPerm?.source).toBe('USER_OVERRIDE');
        expect(leadsPerm?.reason).toBe('Restricted for audit');
      });

      it('should merge role permissions selecting the highest data scope (ALL > DEPARTMENT > ASSIGNED > OWN)', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'u-target',
          userCode: 'EMP001',
          status: RecordStatus.ACTIVE,
          deletedAt: null,
          userType: { code: 'EMPLOYEE' },
          userPermissions: [],
          userRoles: [
            {
              role: {
                code: 'JUNIOR_SALES',
                status: RecordStatus.ACTIVE,
                deletedAt: null,
                permissions: [
                  {
                    dataScope: DataScope.OWN,
                    permission: {
                      code: 'leads.view',
                      name: 'View Leads',
                      module: 'leads',
                      action: 'view',
                      status: RecordStatus.ACTIVE,
                    },
                  },
                ],
              },
            },
            {
              role: {
                code: 'REGIONAL_SALES',
                status: RecordStatus.ACTIVE,
                deletedAt: null,
                permissions: [
                  {
                    dataScope: DataScope.DEPARTMENT,
                    permission: {
                      code: 'leads.view',
                      name: 'View Leads',
                      module: 'leads',
                      action: 'view',
                      status: RecordStatus.ACTIVE,
                    },
                  },
                ],
              },
            },
          ],
        });

        const result = await service.getEffectivePermissions(
          'u-target',
          'sa-id',
          'SUPER_ADMIN',
        );

        const leadsPerm = result.permissions.find(
          (p) => p.code === 'leads.view',
        );
        expect(leadsPerm).toBeDefined();
        expect(leadsPerm?.effect).toBe('ALLOW');
        expect(leadsPerm?.dataScope).toBe(DataScope.DEPARTMENT);
        expect(leadsPerm?.source).toBe('ROLE');
      });
    });
  });
});
