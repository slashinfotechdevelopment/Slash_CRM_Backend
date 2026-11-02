import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { OtpPurpose } from '../../generated/prisma/enums';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: any;

  beforeEach(async () => {
    authService = {
      bootstrapSuperAdmin: jest.fn(),
      sendOtp: jest.fn(),
      verifyOtp: jest.fn(),
      refreshTokens: jest.fn(),
      logout: jest.fn(),
      logoutAll: jest.fn(),
      getMe: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('bootstrapSuperAdmin', () => {
    it('should delegate to authService.bootstrapSuperAdmin', async () => {
      authService.bootstrapSuperAdmin.mockResolvedValue({
        userCode: 'SA001',
        email: 'superadmin@slashinfotech.com',
      });

      const res = await controller.bootstrapSuperAdmin(
        {
          name: 'Super Admin',
          email: 'superadmin@slashinfotech.com',
        },
        '127.0.0.1',
        'Jest-Test-Agent',
      );

      expect(res.success).toBe(true);
      expect(res.data.userCode).toBe('SA001');
      expect(authService.bootstrapSuperAdmin).toHaveBeenCalled();
    });
  });

  describe('sendOtp', () => {
    it('should delegate to authService.sendOtp', async () => {
      authService.sendOtp.mockResolvedValue({
        message: 'If your account is registered and active, a verification code has been sent.',
      });

      const res = await controller.sendOtp(
        { email: 'admin@slashinfotech.com', purpose: OtpPurpose.LOGIN },
        '127.0.0.1',
        'Jest-Test-Agent',
      );

      expect(res.success).toBe(true);
      expect(authService.sendOtp).toHaveBeenCalled();
    });
  });

  describe('verifyOtp', () => {
    it('should delegate to authService.verifyOtp', async () => {
      const mockResult = {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: { id: 'u1', email: 'admin@slashinfotech.com' },
      };
      authService.verifyOtp.mockResolvedValue(mockResult);

      const res = await controller.verifyOtp(
        {
          email: 'admin@slashinfotech.com',
          otp: '123456',
          purpose: OtpPurpose.LOGIN,
        },
        '127.0.0.1',
        'Jest-Test-Agent',
      );

      expect(res.success).toBe(true);
      expect(res.data).toEqual(mockResult);
    });
  });

  describe('logout', () => {
    it('should delegate to authService.logout', async () => {
      authService.logout.mockResolvedValue({ message: 'Logged out successfully.' });

      const res = await controller.logout(
        {
          sub: 'u1',
          email: 'admin@slashinfotech.com',
          sessionId: 's1',
          userCode: 'SA001',
          userType: 'SUPER_ADMIN',
          roles: ['SUPER_ADMIN'],
        },
        '127.0.0.1',
        'Jest-Test-Agent',
      );

      expect(res.success).toBe(true);
      expect(authService.logout).toHaveBeenCalledWith('u1', 's1', '127.0.0.1', 'Jest-Test-Agent');
    });
  });
});

