import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import { EmailService } from '../../../common/email/email.service';
import { OtpPurpose, OtpStatus } from '../../../generated/prisma/enums';

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly otpExpiryMinutes = 5;
  private readonly resendCooldownSeconds = 60;
  private readonly maxAttempts = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Hashes an OTP with HMAC SHA-256 using server secret.
   * Plain OTP values are NEVER persisted to the database.
   */
  private hashOtp(otp: string): string {
    const secret =
      this.configService.get<string>('JWT_SECRET') || 'slash-crm-default-salt';
    return crypto.createHmac('sha256', secret).update(otp).digest('hex');
  }

  /**
   * Generates a cryptographically secure 6-digit numeric OTP.
   */
  private generateSecureOtp(): string {
    return crypto.randomInt(100000, 1000000).toString();
  }

  /**
   * Constant-time comparison between computed hash and stored hash
   * to protect against timing attacks.
   */
  private verifyHashConstantTime(computedHash: string, storedHash: string): boolean {
    const bufferA = Buffer.from(computedHash, 'hex');
    const bufferB = Buffer.from(storedHash, 'hex');

    if (bufferA.length !== bufferB.length) {
      return false;
    }

    return crypto.timingSafeEqual(bufferA, bufferB);
  }

  /**
   * Requests and sends an OTP to the given email.
   * Handles 60s cooldown, invalidating previous pending OTPs,
   * hashing, and sending email.
   */
  async requestOtp(params: {
    email: string;
    purpose: OtpPurpose;
    userId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<{ cooldownSecondsRemaining: number }> {
    const { email, purpose, userId, ipAddress, userAgent } = params;
    const normalizedEmail = email.trim().toLowerCase();

    // 1. Check for 60-second cooldown on latest pending OTP
    const latestOtp = await this.prisma.otpRequest.findFirst({
      where: {
        email: normalizedEmail,
        purpose,
        status: OtpStatus.PENDING,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (latestOtp) {
      const elapsedSeconds = Math.floor(
        (Date.now() - latestOtp.createdAt.getTime()) / 1000,
      );

      if (elapsedSeconds < this.resendCooldownSeconds) {
        const remaining = this.resendCooldownSeconds - elapsedSeconds;
        throw new HttpException(
          {
            success: false,
            message: `Please wait ${remaining} seconds before requesting a new OTP.`,
            cooldownSecondsRemaining: remaining,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // Invalidate existing pending OTPs
      await this.prisma.otpRequest.updateMany({
        where: {
          email: normalizedEmail,
          purpose,
          status: OtpStatus.PENDING,
        },
        data: {
          status: OtpStatus.CANCELLED,
        },
      });
    }

    // 2. Generate 6-digit OTP and calculate expiry
    const otp = this.generateSecureOtp();
    const otpHash = this.hashOtp(otp);
    const expiresAt = new Date(Date.now() + this.otpExpiryMinutes * 60 * 1000);

    // 3. Save OTP request record (ONLY the hash is stored)
    await this.prisma.otpRequest.create({
      data: {
        userId: userId || null,
        email: normalizedEmail,
        purpose,
        otpHash,
        status: OtpStatus.PENDING,
        attempts: 0,
        maxAttempts: this.maxAttempts,
        expiresAt,
        requestIp: ipAddress || null,
        userAgent: userAgent?.substring(0, 500) || null,
      },
    });

    // 4. Send email with OTP
    await this.sendOtpEmail(normalizedEmail, otp, purpose);

    return { cooldownSecondsRemaining: this.resendCooldownSeconds };
  }

  /**
   * Verifies an OTP for given email and purpose.
   */
  async verifyOtp(params: {
    email: string;
    otp: string;
    purpose: OtpPurpose;
  }): Promise<{ verified: boolean; otpRequestId: string; userId: string | null }> {
    const { email, otp, purpose } = params;
    const normalizedEmail = email.trim().toLowerCase();

    // 1. Find active pending OTP request
    const otpRecord = await this.prisma.otpRequest.findFirst({
      where: {
        email: normalizedEmail,
        purpose,
        status: OtpStatus.PENDING,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otpRecord) {
      throw new UnauthorizedException('Invalid or expired OTP code.');
    }

    // 2. Check if expired
    if (new Date() > otpRecord.expiresAt) {
      await this.prisma.otpRequest.update({
        where: { id: otpRecord.id },
        data: { status: OtpStatus.EXPIRED },
      });
      throw new UnauthorizedException('OTP has expired. Please request a new one.');
    }

    // 3. Check attempts
    if (otpRecord.attempts >= otpRecord.maxAttempts) {
      await this.prisma.otpRequest.update({
        where: { id: otpRecord.id },
        data: { status: OtpStatus.LOCKED },
      });
      throw new UnauthorizedException(
        'Maximum verification attempts exceeded. Please request a new OTP.',
      );
    }

    // 4. Verify OTP using constant-time comparison
    const computedHash = this.hashOtp(otp);
    const isMatch = this.verifyHashConstantTime(computedHash, otpRecord.otpHash);

    if (!isMatch) {
      const nextAttempts = otpRecord.attempts + 1;
      const isNowLocked = nextAttempts >= otpRecord.maxAttempts;

      await this.prisma.otpRequest.update({
        where: { id: otpRecord.id },
        data: {
          attempts: nextAttempts,
          status: isNowLocked ? OtpStatus.LOCKED : OtpStatus.PENDING,
        },
      });

      if (isNowLocked) {
        throw new UnauthorizedException(
          'Maximum verification attempts exceeded. Please request a new OTP.',
        );
      }

      const remainingAttempts = otpRecord.maxAttempts - nextAttempts;
      throw new UnauthorizedException(
        `Invalid OTP code. ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining.`,
      );
    }

    // 5. Success: Mark OTP as VERIFIED and consumed
    const now = new Date();
    await this.prisma.otpRequest.update({
      where: { id: otpRecord.id },
      data: {
        status: OtpStatus.VERIFIED,
        verifiedAt: now,
        consumedAt: now,
      },
    });

    return {
      verified: true,
      otpRequestId: otpRecord.id,
      userId: otpRecord.userId,
    };
  }

  /**
   * Helper to format and send the OTP email with secure HTML formatting.
   */
  private async sendOtpEmail(
    toEmail: string,
    otp: string,
    purpose: OtpPurpose,
  ): Promise<void> {
    const isVerification = purpose === OtpPurpose.EMAIL_VERIFICATION;
    const subject = isVerification
      ? 'Slash Infotech CRM — Verify Your Email'
      : 'Slash Infotech CRM — Login Verification Code';

    const purposeTitle = isVerification
      ? 'Email Verification'
      : 'Secure CRM Login';

    const actionText = isVerification
      ? 'complete your email verification'
      : 'sign in to your Slash Infotech CRM account';

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f7f6; margin: 0; padding: 20px; color: #333333; }
          .container { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08); }
          .header { background: #0f172a; padding: 24px; text-align: center; }
          .header h1 { color: #ffffff; margin: 0; font-size: 20px; font-weight: 600; letter-spacing: 0.5px; }
          .content { padding: 32px 28px; }
          .code-box { background: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 8px; text-align: center; padding: 20px; margin: 24px 0; }
          .otp-code { font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #0284c7; font-family: 'Courier New', Courier, monospace; }
          .info-text { font-size: 14px; line-height: 1.6; color: #475569; }
          .warning-text { font-size: 13px; line-height: 1.5; color: #b91c1c; margin-top: 20px; padding: 12px; background: #fef2f2; border-radius: 6px; }
          .footer { padding: 20px 28px; background: #f8fafc; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #94a3b8; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Slash Infotech CRM</h1>
          </div>
          <div class="content">
            <h2 style="font-size: 18px; margin-top: 0; color: #1e293b;">${purposeTitle}</h2>
            <p class="info-text">
              Use the single-use code below to ${actionText}. This code is valid for <strong>${this.otpExpiryMinutes} minutes</strong>.
            </p>
            <div class="code-box">
              <span class="otp-code">${otp}</span>
            </div>
            <p class="info-text">
              If you did not request this verification code, please ignore this email or notify your system administrator immediately.
            </p>
            <div class="warning-text">
              <strong>Security reminder:</strong> Slash Infotech staff will never ask for your verification code. Never share this code with anyone.
            </div>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} Slash Infotech. All rights reserved.
          </div>
        </div>
      </body>
      </html>
    `;

    const text = `Slash Infotech CRM\n\nYour ${purposeTitle} code is: ${otp}\n\nThis code will expire in ${this.otpExpiryMinutes} minutes. If you did not request this, please disregard this message.`;

    await this.emailService.sendEmail(toEmail, subject, html, text);
  }
}

