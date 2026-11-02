import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RecordStatus } from '../../generated/prisma/enums';

describe('PermissionsService', () => {
  let service: PermissionsService;
  let prisma: any;
  let auditService: any;

  beforeEach(async () => {
    prisma = {
      permission: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
    };

    auditService = {
      logAudit: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PermissionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = module.get<PermissionsService>(PermissionsService);
  });

  describe('create', () => {
    it('should create a new permission successfully', async () => {
      prisma.permission.findUnique.mockResolvedValue(null);
      prisma.permission.create.mockResolvedValue({
        id: 'p1',
        code: 'leads.export',
        name: 'Export Leads',
        module: 'leads',
        action: 'export',
        status: RecordStatus.ACTIVE,
      });

      const result = await service.create({
        code: 'leads.export',
        name: 'Export Leads',
        module: 'leads',
        action: 'export',
      });

      expect(result.code).toBe('leads.export');
      expect(prisma.permission.create).toHaveBeenCalled();
      expect(auditService.logAudit).toHaveBeenCalled();
    });

    it('should reject duplicate permission code', async () => {
      prisma.permission.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        service.create({
          code: 'leads.view',
          name: 'View Leads',
          module: 'leads',
          action: 'view',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('findGroupedByModule', () => {
    it('should group permissions by module', async () => {
      prisma.permission.findMany.mockResolvedValue([
        { id: '1', module: 'users', code: 'users.view', name: 'View Users', action: 'view' },
        { id: '2', module: 'users', code: 'users.create', name: 'Create Users', action: 'create' },
        { id: '3', module: 'leads', code: 'leads.view', name: 'View Leads', action: 'view' },
      ]);

      const result = await service.findGroupedByModule();

      expect(result.users).toHaveLength(2);
      expect(result.leads).toHaveLength(1);
    });
  });

  describe('remove', () => {
    it('should prevent deletion of permission assigned to protected system roles', async () => {
      prisma.permission.findUnique.mockResolvedValue({
        id: 'p1',
        code: 'users.delete',
        roles: [
          { role: { name: 'Super Admin', isSystem: true } },
        ],
      });

      await expect(service.remove('p1')).rejects.toThrow(BadRequestException);
    });

    it('should delete permission if not assigned to system roles', async () => {
      prisma.permission.findUnique.mockResolvedValue({
        id: 'p1',
        code: 'custom.action',
        roles: [
          { role: { name: 'Custom Role', isSystem: false } },
        ],
      });
      prisma.permission.delete.mockResolvedValue({});

      const result = await service.remove('p1');
      expect(result.message).toContain('deleted successfully');
      expect(prisma.permission.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    });
  });
});

