import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { OtpService } from './otp.service';
import { PrismaService } from '../../../database/prisma.service';
import { EmailService } from '../../../common/email/email.service';
import { OtpPurpose, OtpStatus } from '../../../generated/prisma/enums';

describe('OtpService', () => {
  let service: OtpService;
  let prisma: any;
  let emailService: any;

  beforeEach(async () => {
    prisma = {
      otpRequest: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    emailService = {
      sendEmail: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: emailService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('test-secret-salt'),
          },
        },
      ],
    }).compile();

    service = module.get<OtpService>(OtpService);
  });

  describe('requestOtp', () => {
    it('should generate, hash and save an OTP and send an email', async () => {
      prisma.otpRequest.findFirst.mockResolvedValue(null);
      prisma.otpRequest.create.mockResolvedValue({ id: 'otp-1' });

      const result = await service.requestOtp({
        email: 'test@slashinfotech.com',
        purpose: OtpPurpose.LOGIN,
      });

      expect(result).toEqual({ cooldownSecondsRemaining: 60 });
      expect(prisma.otpRequest.create).toHaveBeenCalled();
      const createArgs = prisma.otpRequest.create.mock.calls[0][0].data;
      expect(createArgs.email).toBe('test@slashinfotech.com');
      expect(createArgs.purpose).toBe(OtpPurpose.LOGIN);
      expect(createArgs.status).toBe(OtpStatus.PENDING);
      expect(createArgs.otpHash).toBeDefined();
      // Ensure plain OTP is not in the stored object
      expect(createArgs.otp).toBeUndefined();
      expect(emailService.sendEmail).toHaveBeenCalled();
    });

    it('should enforce 60-second cooldown', async () => {
      // Pending OTP created 20 seconds ago
      prisma.otpRequest.findFirst.mockResolvedValue({
        id: 'otp-recent',
        createdAt: new Date(Date.now() - 20 * 1000),
      });

      await expect(
        service.requestOtp({
          email: 'test@slashinfotech.com',
          purpose: OtpPurpose.LOGIN,
        }),
      ).rejects.toThrow(HttpException);
    });

    it('should invalidate previous pending OTPs when requesting after cooldown', async () => {
      // Pending OTP created 70 seconds ago
      prisma.otpRequest.findFirst.mockResolvedValue({
        id: 'otp-old',
        createdAt: new Date(Date.now() - 70 * 1000),
      });
      prisma.otpRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.otpRequest.create.mockResolvedValue({ id: 'otp-new' });

      await service.requestOtp({
        email: 'test@slashinfotech.com',
        purpose: OtpPurpose.LOGIN,
      });

      expect(prisma.otpRequest.updateMany).toHaveBeenCalledWith({
        where: {
          email: 'test@slashinfotech.com',
          purpose: OtpPurpose.LOGIN,
          status: OtpStatus.PENDING,
        },
        data: {
          status: OtpStatus.CANCELLED,
        },
      });
    });
  });

  describe('verifyOtp', () => {
    it('should throw UnauthorizedException if OTP request does not exist', async () => {
      prisma.otpRequest.findFirst.mockResolvedValue(null);

      await expect(
        service.verifyOtp({
          email: 'test@slashinfotech.com',
          otp: '123456',
          purpose: OtpPurpose.LOGIN,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if OTP has expired', async () => {
      prisma.otpRequest.findFirst.mockResolvedValue({
        id: 'otp-expired',
        expiresAt: new Date(Date.now() - 60 * 1000),
        attempts: 0,
        maxAttempts: 5,
      });
      prisma.otpRequest.update.mockResolvedValue({});

      await expect(
        service.verifyOtp({
          email: 'test@slashinfotech.com',
          otp: '123456',
          purpose: OtpPurpose.LOGIN,
        }),
      ).rejects.toThrow('OTP has expired. Please request a new one.');
    });

    it('should increment attempts and lock if max attempts reached', async () => {
      prisma.otpRequest.findFirst.mockResolvedValue({
        id: 'otp-attempt-4',
        expiresAt: new Date(Date.now() + 180 * 1000),
        attempts: 4,
        maxAttempts: 5,
        otpHash: 'mismatched-hash',
      });
      prisma.otpRequest.update.mockResolvedValue({});

      await expect(
        service.verifyOtp({
          email: 'test@slashinfotech.com',
          otp: '123456',
          purpose: OtpPurpose.LOGIN,
        }),
      ).rejects.toThrow('Maximum verification attempts exceeded. Please request a new OTP.');

      expect(prisma.otpRequest.update).toHaveBeenCalledWith({
        where: { id: 'otp-attempt-4' },
        data: { attempts: 5, status: OtpStatus.LOCKED },
      });
    });
  });
});

