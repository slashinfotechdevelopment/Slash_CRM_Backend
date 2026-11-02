import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RolesService } from './roles.service';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { DataScope, RecordStatus } from '../../generated/prisma/enums';

describe('RolesService', () => {
  let service: RolesService;
  let prisma: any;
  let auditService: any;

  beforeEach(async () => {
    prisma = {
      role: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      permission: {
        count: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      rolePermission: {
        create: jest.fn(),
        deleteMany: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      userRole: {
        count: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      userPermission: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => callback(prisma)),
    };

    auditService = {
      logAudit: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = module.get<RolesService>(RolesService);
  });

  describe('create', () => {
    it('should create a custom role successfully', async () => {
      prisma.role.findUnique
        .mockResolvedValueOnce(null) // existence check
        .mockResolvedValueOnce({ // findOne after creation
          id: 'r1',
          code: 'BRANCH_MANAGER',
          name: 'Branch Manager',
          permissions: [],
          _count: { users: 0 },
        });

      prisma.role.create.mockResolvedValue({ id: 'r1', code: 'BRANCH_MANAGER' });

      const result = await service.create({
        code: 'BRANCH_MANAGER',
        name: 'Branch Manager',
      });

      expect(result.code).toBe('BRANCH_MANAGER');
      expect(prisma.role.create).toHaveBeenCalled();
      expect(auditService.logAudit).toHaveBeenCalled();
    });

    it('should reject duplicate role code', async () => {
      prisma.role.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        service.create({ code: 'ADMIN', name: 'Admin' }),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject role creation with unauthorized permission delegation by non-Super Admin', async () => {
      prisma.role.findUnique.mockResolvedValue(null);
      prisma.permission.count.mockResolvedValue(1);
      prisma.permission.findMany.mockResolvedValue([{ id: 'p1', code: 'users.delete' }]);

      // Actor has only leads.view
      prisma.userRole.findMany.mockResolvedValue([
        {
          role: {
            status: RecordStatus.ACTIVE,
            deletedAt: null,
            permissions: [{ permission: { code: 'leads.view', status: RecordStatus.ACTIVE } }],
          },
        },
      ]);
      prisma.userPermission.findMany.mockResolvedValue([]);

      await expect(
        service.create(
          {
            code: 'CUSTOM_ROLE',
            name: 'Custom Role',
            permissions: [{ permissionId: 'p1', dataScope: DataScope.ALL }],
          },
          'admin-user-id',
          'ADMIN',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('update', () => {
    it('should protect Super Admin role from deactivation', async () => {
      prisma.role.findUnique.mockResolvedValue({
        id: 'r-sa',
        code: 'SUPER_ADMIN',
        name: 'Super Admin',
        isSystem: true,
        permissions: [],
        _count: { users: 1 },
      });

      await expect(
        service.update('r-sa', { status: RecordStatus.INACTIVE }, 'sa-id', 'SUPER_ADMIN'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject system role modification by non-Super Admin', async () => {
      prisma.role.findUnique.mockResolvedValue({
        id: 'r-admin',
        code: 'ADMIN',
        name: 'Admin',
        isSystem: true,
        permissions: [],
        _count: { users: 2 },
      });

      await expect(
        service.update('r-admin', { name: 'Renamed Admin' }, 'admin-id', 'ADMIN'),
      ).rejects.toThrow('Only Super Admin can modify protected system roles.');
    });

    it('should allow Super Admin to modify system role metadata', async () => {
      prisma.role.findUnique.mockResolvedValue({
        id: 'r-admin',
        code: 'ADMIN',
        name: 'Admin',
        isSystem: true,
        permissions: [],
        _count: { users: 2 },
      });

      prisma.role.update.mockResolvedValue({
        id: 'r-admin',
        name: 'Updated Admin Name',
      });

      const res = await service.update(
        'r-admin',
        { name: 'Updated Admin Name' },
        'sa-id',
        'SUPER_ADMIN',
      );

      expect(res.name).toBe('Updated Admin Name');
      expect(prisma.role.update).toHaveBeenCalled();
    });

    it('should reject update on soft-deleted role with 404', async () => {
      prisma.role.findUnique.mockResolvedValue({
        id: 'r-deleted',
        code: 'OLD_ROLE',
        name: 'Old Role',
        deletedAt: new Date(),
      });

      await expect(
        service.update('r-deleted', { name: 'New Name' }, 'sa-id', 'SUPER_ADMIN'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('findOne', () => {
    it('should throw NotFoundException for soft-deleted role by default', async () => {
      prisma.role.findUnique.mockResolvedValue({
        id: 'r-del',
        deletedAt: new Date(),
      });

      await expect(service.findOne('r-del')).rejects.toThrow(NotFoundException);
    });

    it('should return soft-deleted role when includeDeleted is true', async () => {
      prisma.role.findUnique.mockResolvedValue({
        id: 'r-del',
        name: 'Deleted Role',
        deletedAt: new Date(),
      });

      const role = await service.findOne('r-del', true);
      expect(role.id).toBe('r-del');
    });
  });

  describe('remove', () => {
    it('should prevent deletion of protected system roles', async () => {
      prisma.role.findUnique.mockResolvedValue({
        id: 'r-sys',
        code: 'ADMIN',
        name: 'Admin',
        isSystem: true,
      });

      await expect(service.remove('r-sys')).rejects.toThrow(BadRequestException);
    });

    it('should prevent deletion of roles assigned to active users', async () => {
      prisma.role.findUnique.mockResolvedValue({
        id: 'r-custom',
        code: 'CUSTOM_ROLE',
        name: 'Custom Role',
        isSystem: false,
      });

      prisma.userRole.count.mockResolvedValue(3); // 3 active users assigned

      await expect(service.remove('r-custom')).rejects.toThrow(
        'is currently assigned to 3 active user(s)',
      );
    });

    it('should soft delete role when safety checks pass', async () => {
      prisma.role.findUnique.mockResolvedValue({
        id: 'r-custom',
        code: 'CUSTOM_ROLE',
        name: 'Custom Role',
        isSystem: false,
      });

      prisma.userRole.count.mockResolvedValue(0); // 0 active users
      prisma.role.update.mockResolvedValue({});

      const result = await service.remove('r-custom');

      expect(result.message).toContain('soft deleted successfully');
      expect(prisma.role.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'r-custom' },
          data: expect.objectContaining({ status: RecordStatus.INACTIVE }),
        }),
      );
    });
  });

  describe('restore', () => {
    it('should forbid non-Super Admin from restoring roles', async () => {
      await expect(
        service.restore('r-1', 'admin-id', 'ADMIN'),
      ).rejects.toThrow('Only Super Admin can restore roles.');
    });

    it('should reject restoration if role is not deleted', async () => {
      prisma.role.findUnique.mockResolvedValue({
        id: 'r-1',
        name: 'Active Role',
        deletedAt: null,
      });

      await expect(
        service.restore('r-1', 'sa-id', 'SUPER_ADMIN'),
      ).rejects.toThrow('is not deleted');
    });

    it('should reject restoration of system role', async () => {
      prisma.role.findUnique.mockResolvedValue({
        id: 'r-sys',
        name: 'System Role',
        isSystem: true,
        deletedAt: new Date(),
      });

      await expect(
        service.restore('r-sys', 'sa-id', 'SUPER_ADMIN'),
      ).rejects.toThrow('Protected system roles cannot be restored');
    });

    it('should successfully restore a soft-deleted custom role', async () => {
      prisma.role.findUnique.mockResolvedValue({
        id: 'r-custom',
        name: 'Custom Role',
        isSystem: false,
        deletedAt: new Date(),
      });

      prisma.role.update.mockResolvedValue({
        id: 'r-custom',
        name: 'Custom Role',
        deletedAt: null,
        status: RecordStatus.ACTIVE,
      });

      const res = await service.restore('r-custom', 'sa-id', 'SUPER_ADMIN');

      expect(res.deletedAt).toBeNull();
      expect(res.status).toBe(RecordStatus.ACTIVE);
      expect(auditService.logAudit).toHaveBeenCalled();
    });
  });

  describe('replacePermissions', () => {
    it('should forbid replacing permissions on SUPER_ADMIN role', async () => {
      prisma.role.findUnique.mockResolvedValue({
        id: 'r-sa',
        code: 'SUPER_ADMIN',
        permissions: [],
        _count: { users: 1 },
      });

      await expect(
        service.replacePermissions('r-sa', {
          permissions: [{ permissionId: 'p1', dataScope: DataScope.ALL }],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should enforce delegation authority for non-Super Admin', async () => {
      prisma.role.findUnique.mockResolvedValue({
        id: 'r-custom',
        code: 'CUSTOM',
        permissions: [],
        _count: { users: 0 },
      });

      prisma.permission.count.mockResolvedValue(1);
      prisma.permission.findMany.mockResolvedValue([{ id: 'p-secret', code: 'audit_logs.view' }]);

      // User has only leads.view
      prisma.userRole.findMany.mockResolvedValue([
        {
          role: {
            status: RecordStatus.ACTIVE,
            deletedAt: null,
            permissions: [{ permission: { code: 'leads.view', status: RecordStatus.ACTIVE } }],
          },
        },
      ]);
      prisma.userPermission.findMany.mockResolvedValue([]);

      await expect(
        service.replacePermissions(
          'r-custom',
          { permissions: [{ permissionId: 'p-secret', dataScope: DataScope.ALL }] },
          'admin-user',
          'ADMIN',
        ),
      ).rejects.toThrow('Cannot delegate permissions you do not possess: [audit_logs.view]');
    });

    it('should allow Super Admin to replace permissions universally', async () => {
      prisma.role.findUnique
        .mockResolvedValueOnce({
          id: 'r-custom',
          code: 'CUSTOM',
          permissions: [],
          _count: { users: 0 },
        })
        .mockResolvedValueOnce({
          id: 'r-custom',
          code: 'CUSTOM',
          permissions: [{ permissionId: 'p-1', dataScope: DataScope.ALL }],
          _count: { users: 0 },
        });

      prisma.permission.count.mockResolvedValue(1);
      prisma.rolePermission.deleteMany.mockResolvedValue({ count: 1 });
      prisma.rolePermission.create.mockResolvedValue({});

      const res = await service.replacePermissions(
        'r-custom',
        { permissions: [{ permissionId: 'p-1', dataScope: DataScope.ALL }] },
        'sa-user',
        'SUPER_ADMIN',
      );

      expect(res.id).toBe('r-custom');
      expect(prisma.rolePermission.deleteMany).toHaveBeenCalled();
      expect(prisma.rolePermission.create).toHaveBeenCalled();
    });
  });
});
