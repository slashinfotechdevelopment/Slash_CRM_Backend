import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { OtpService } from './services/otp.service';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { UserCodeService } from '../../common/services/user-code.service';
import { OtpPurpose, RecordStatus, SessionStatus } from '../../generated/prisma/enums';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let otpService: any;
  let jwtService: any;
  let userCodeService: any;
  let auditService: any;

  beforeEach(async () => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      userType: {
        findUnique: jest.fn(),
      },
      role: {
        findUnique: jest.fn(),
      },
      userRole: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      userPermission: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      permission: {
        findMany: jest.fn().mockResolvedValue([{ code: 'dashboard.view' }]),
      },
      userSession: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => {
        return callback(prisma);
      }),
    };

    otpService = {
      requestOtp: jest.fn().mockResolvedValue({ cooldownSecondsRemaining: 60 }),
      verifyOtp: jest.fn().mockResolvedValue({ verified: true }),
    };

    jwtService = {
      signAsync: jest.fn().mockResolvedValue('mock-jwt-token'),
      verifyAsync: jest.fn(),
    };

    userCodeService = {
      generateNextCode: jest.fn().mockResolvedValue('SA001'),
    };

    auditService = {
      logAudit: jest.fn().mockResolvedValue(undefined),
      logActivity: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: OtpService, useValue: otpService },
        { provide: JwtService, useValue: jwtService },
        { provide: UserCodeService, useValue: userCodeService },
        { provide: AuditService, useValue: auditService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('test-jwt-secret'),
            getOrThrow: jest.fn().mockReturnValue('test-jwt-secret'),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('bootstrapSuperAdmin', () => {
    it('should successfully bootstrap the first Super Admin', async () => {
      prisma.user.findFirst.mockResolvedValue(null); // No super admin exists
      prisma.user.findUnique.mockResolvedValue(null); // Email not taken
      prisma.userType.findUnique.mockResolvedValue({ id: 'ut-sa', code: 'SUPER_ADMIN' });
      prisma.role.findUnique.mockResolvedValue({ id: 'r-sa', code: 'SUPER_ADMIN' });

      const createdUser = {
        id: 'u-1',
        userCode: 'SA001',
        name: 'Initial Super Admin',
        email: 'superadmin@slashinfotech.com',
        phone: '+919876543210',
        status: RecordStatus.ACTIVE,
        emailVerifiedAt: null,
      };

      prisma.user.create.mockResolvedValue(createdUser);

      const result = await service.bootstrapSuperAdmin({
        name: 'Initial Super Admin',
        email: 'superadmin@slashinfotech.com',
        phone: '+919876543210',
      });

      expect(result).toEqual({
        userCode: 'SA001',
        email: 'superadmin@slashinfotech.com',
      });
      expect(userCodeService.generateNextCode).toHaveBeenCalledWith('SUPER_ADMIN', prisma);
      expect(otpService.requestOtp).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'superadmin@slashinfotech.com',
          purpose: OtpPurpose.EMAIL_VERIFICATION,
        }),
      );
      expect(auditService.logAudit).toHaveBeenCalled();
    });

    it('should reject bootstrap if a Super Admin already exists', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'existing-sa' });

      await expect(
        service.bootstrapSuperAdmin({
          name: 'Another Admin',
          email: 'another@slashinfotech.com',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('sendOtp', () => {
    it('should return generic success message if user does not exist (anti-enumeration)', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const result = await service.sendOtp({
        email: 'nonexistent@slashinfotech.com',
        purpose: OtpPurpose.LOGIN,
      });

      expect(result.message).toContain('If your account is registered and active');
      expect(otpService.requestOtp).not.toHaveBeenCalled();
    });

    it('should dispatch OTP if user exists, active, and verified', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-1',
        email: 'user@slashinfotech.com',
        status: RecordStatus.ACTIVE,
        emailVerifiedAt: new Date(),
        userType: { code: 'EMPLOYEE' },
      });

      const result = await service.sendOtp({
        email: 'user@slashinfotech.com',
        purpose: OtpPurpose.LOGIN,
      });

      expect(result.message).toContain('If your account is registered and active');
      expect(otpService.requestOtp).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'user@slashinfotech.com',
          purpose: OtpPurpose.LOGIN,
        }),
      );
    });
  });

  describe('verifyOtp', () => {
    it('should issue access token and refresh token upon successful OTP verification', async () => {
      const mockUser = {
        id: 'u-1',
        userCode: 'SA001',
        name: 'Super Admin',
        email: 'admin@slashinfotech.com',
        phone: null,
        status: RecordStatus.ACTIVE,
        emailVerifiedAt: new Date(),
        userType: { code: 'SUPER_ADMIN' },
        userRoles: [{ role: { code: 'SUPER_ADMIN' } }],
      };

      prisma.user.findFirst.mockResolvedValue(mockUser);
      prisma.userSession.create.mockResolvedValue({ id: 'sess-1' });

      const result = await service.verifyOtp({
        email: 'admin@slashinfotech.com',
        otp: '123456',
        purpose: OtpPurpose.LOGIN,
      });

      expect(result.accessToken).toBe('mock-jwt-token');
      expect(result.refreshToken).toBeDefined();
      expect(result.user.email).toBe('admin@slashinfotech.com');
      expect(prisma.userSession.create).toHaveBeenCalled();
      expect(auditService.logAudit).toHaveBeenCalled();
    });
  });

  describe('refreshTokens', () => {
    it('should rotate tokens for active session', async () => {
      const mockSession = {
        id: 'sess-1',
        status: SessionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 86400000),
        user: {
          id: 'u-1',
          userCode: 'SA001',
          email: 'admin@slashinfotech.com',
          status: RecordStatus.ACTIVE,
          deletedAt: null,
          userType: { code: 'SUPER_ADMIN' },
          userRoles: [],
        },
      };

      prisma.userSession.findFirst.mockResolvedValue(mockSession);
      prisma.userSession.update.mockResolvedValue({});

      const result = await service.refreshTokens({
        refreshToken: 'valid-refresh-token',
      });

      expect(result.accessToken).toBe('mock-jwt-token');
      expect(result.refreshToken).toBeDefined();
      expect(prisma.userSession.update).toHaveBeenCalled();
    });

    it('should throw UnauthorizedException if session is expired or not found', async () => {
      prisma.userSession.findFirst.mockResolvedValue(null);

      await expect(
        service.refreshTokens({ refreshToken: 'invalid-token' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});

