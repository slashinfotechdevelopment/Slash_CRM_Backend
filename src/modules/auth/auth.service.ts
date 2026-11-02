import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { UserCodeService } from '../../common/services/user-code.service';
import { OtpService } from './services/otp.service';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { BootstrapSuperAdminDto } from './dto/bootstrap-super-admin.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import {
  AuditAction,
  OtpPurpose,
  PermissionEffect,
  RecordStatus,
  SessionStatus,
} from '../../generated/prisma/enums';

export interface JwtPayload {
  sub: string;
  email: string;
  userCode: string;
  userType: string;
  roles: string[];
  sessionId: string;
}

export interface AuthResponseData {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    userCode: string;
    name: string;
    email: string;
    userType: string;
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly sessionExpiryDays = 7;
  private readonly accessTokenExpiry = '15m';

  constructor(
    private readonly prisma: PrismaService,
    private readonly otpService: OtpService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly userCodeService: UserCodeService,
  ) { }

  /**
   * Hashes a raw refresh token using SHA-256 before storage.
   * Plain tokens are never stored in the database.
   */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Generates a cryptographically strong random refresh token string.
   */
  private generateRawRefreshToken(): string {
    return crypto.randomBytes(40).toString('hex');
  }

  /**
   * Resolves effective permissions for a user:
   * 1. If SUPER_ADMIN user type, returns all active permissions.
   * 2. Otherwise aggregates permissions from user's roles.
   * 3. Applies explicit UserPermission overrides (DENY overrides ALLOW).
   */
  private async resolveUserPermissions(
    userId: string,
    userTypeCode: string,
  ): Promise<string[]> {
    if (userTypeCode === 'SUPER_ADMIN') {
      const allActivePerms = await this.prisma.permission.findMany({
        where: { status: RecordStatus.ACTIVE },
        select: { code: true },
      });
      return allActivePerms.map((p) => p.code);
    }

    // 1. Role-based permissions
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: {
        role: {
          include: {
            permissions: {
              include: { permission: true },
            },
          },
        },
      },
    });

    const permissionSet = new Set<string>();
    for (const ur of userRoles) {
      if (ur.role.status === RecordStatus.ACTIVE && !ur.role.deletedAt) {
        for (const rp of ur.role.permissions) {
          if (rp.permission.status === RecordStatus.ACTIVE) {
            permissionSet.add(rp.permission.code);
          }
        }
      }
    }

    // 2. User-specific permission overrides (DENY overrides ALLOW)
    const userPermissions = await this.prisma.userPermission.findMany({
      where: { userId },
      include: { permission: true },
    });

    for (const up of userPermissions) {
      if (up.permission.status === RecordStatus.ACTIVE) {
        if (up.effect === PermissionEffect.DENY) {
          permissionSet.delete(up.permission.code);
        } else if (up.effect === PermissionEffect.ALLOW) {
          permissionSet.add(up.permission.code);
        }
      }
    }

    return Array.from(permissionSet);
  }

  /**
   * Secure Super Admin Bootstrap.
   * Only allows execution if no Super Admin user exists in the database.
   */
  async bootstrapSuperAdmin(
    dto: BootstrapSuperAdminDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ userCode: string; email: string }> {
    const normalizedEmail = dto.email.trim().toLowerCase();

    // 1. Verify that no Super Admin already exists
    const existingSuperAdmin = await this.prisma.user.findFirst({
      where: {
        userType: { code: 'SUPER_ADMIN' },
        deletedAt: null,
      },
    });

    if (existingSuperAdmin) {
      throw new ForbiddenException(
        'Super Admin is already initialized. Bootstrap is disabled.',
      );
    }

    // 2. Check if the provided email is already used
    const existingEmail = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingEmail) {
      throw new BadRequestException('A user with this email address already exists.');
    }

    // 3. Find SUPER_ADMIN user type
    const superAdminUserType = await this.prisma.userType.findUnique({
      where: { code: 'SUPER_ADMIN' },
    });

    if (!superAdminUserType) {
      throw new InternalServerErrorException(
        'SUPER_ADMIN user type not found in database. Please run initial seed.',
      );
    }

    // 4. Find SUPER_ADMIN role
    const superAdminRole = await this.prisma.role.findUnique({
      where: { code: 'SUPER_ADMIN' },
    });

    if (!superAdminRole) {
      throw new InternalServerErrorException(
        'SUPER_ADMIN role not found in database. Please run initial seed.',
      );
    }

    // 5. Create Super Admin atomically in transaction
    const newUser = await this.prisma.$transaction(async (tx) => {
      const userCode = await this.userCodeService.generateNextCode(
        'SUPER_ADMIN',
        tx,
      );

      const user = await tx.user.create({
        data: {
          userCode,
          userTypeId: superAdminUserType.id,
          name: dto.name,
          email: normalizedEmail,
          phone: dto.phone || null,
          status: RecordStatus.ACTIVE,
          emailVerifiedAt: null, // Must verify email before normal login
        },
      });

      await tx.userRole.create({
        data: {
          userId: user.id,
          roleId: superAdminRole.id,
        },
      });

      return user;
    });

    // 6. Send email verification OTP
    await this.otpService.requestOtp({
      email: newUser.email,
      purpose: OtpPurpose.EMAIL_VERIFICATION,
      userId: newUser.id,
      ipAddress,
      userAgent,
    });

    // 7. Audit log creation
    await this.auditService.logAudit({
      actorUserId: newUser.id,
      action: AuditAction.CREATE,
      module: 'auth',
      entityType: 'User',
      entityId: newUser.id,
      newValues: {
        id: newUser.id,
        userCode: newUser.userCode,
        name: newUser.name,
        email: newUser.email,
        userType: 'SUPER_ADMIN',
      },
      ipAddress,
      userAgent,
    });

    await this.auditService.logActivity({
      actorUserId: newUser.id,
      action: 'BOOTSTRAP_SUPER_ADMIN',
      module: 'auth',
      entityType: 'User',
      entityId: newUser.id,
      description: `Super Admin account initialized for ${newUser.email} with code ${newUser.userCode}.`,
      ipAddress,
    });

    return {
      userCode: newUser.userCode,
      email: newUser.email,
    };
  }

  /**
   * Request OTP for login or email verification.
   * Consistent response prevents account enumeration attacks.
   */
  async sendOtp(
    dto: SendOtpDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ message: string }> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const purpose = dto.purpose || OtpPurpose.LOGIN;

    const user = await this.prisma.user.findFirst({
      where: {
        email: normalizedEmail,
        deletedAt: null,
      },
      include: { userType: true },
    });

    if (purpose === OtpPurpose.LOGIN) {
      // If user does not exist or is inactive, return standard success message
      // without sending OTP, preventing email enumeration.
      if (!user || user.status !== RecordStatus.ACTIVE) {
        return {
          message:
            'If your account is registered and active, a verification code has been sent.',
        };
      }

      // Check if email has been verified
      if (!user.emailVerifiedAt) {
        throw new BadRequestException(
          'Email address is not yet verified. Please request an email verification code first.',
        );
      }

      await this.otpService.requestOtp({
        email: normalizedEmail,
        purpose: OtpPurpose.LOGIN,
        userId: user.id,
        ipAddress,
        userAgent,
      });

      return {
        message:
          'If your account is registered and active, a verification code has been sent.',
      };
    }

    if (purpose === OtpPurpose.EMAIL_VERIFICATION) {
      if (!user || user.status !== RecordStatus.ACTIVE) {
        return {
          message:
            'If your account is registered and active, a verification code has been sent.',
        };
      }

      if (user.emailVerifiedAt) {
        throw new BadRequestException('Email address is already verified.');
      }

      await this.otpService.requestOtp({
        email: normalizedEmail,
        purpose: OtpPurpose.EMAIL_VERIFICATION,
        userId: user.id,
        ipAddress,
        userAgent,
      });

      return {
        message: 'A verification code has been sent to your email.',
      };
    }

    throw new BadRequestException('Invalid OTP purpose.');
  }

  /**
   * Verifies OTP, marks email verified (if applicable), generates user session,
   * and issues JWT access token + refresh token.
   */
  async verifyOtp(
    dto: VerifyOtpDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseData> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const purpose = dto.purpose || OtpPurpose.LOGIN;

    // 1. Verify OTP with attempts limit & constant-time check
    try {
      await this.otpService.verifyOtp({
        email: normalizedEmail,
        otp: dto.otp,
        purpose,
      });
    } catch (error) {
      // Record failed login audit log if user exists
      const maybeUser = await this.prisma.user.findFirst({
        where: { email: normalizedEmail, deletedAt: null },
      });

      await this.auditService.logAudit({
        actorUserId: maybeUser?.id || null,
        action: AuditAction.LOGIN_FAILED,
        module: 'auth',
        entityType: 'User',
        entityId: maybeUser?.id || null,
        newValues: { email: normalizedEmail, reason: 'OTP verification failed' },
        ipAddress,
        userAgent,
      });

      throw error;
    }

    // 2. Fetch user with relations
    const user = await this.prisma.user.findFirst({
      where: {
        email: normalizedEmail,
        deletedAt: null,
      },
      include: {
        userType: true,
        userRoles: {
          include: { role: true },
        },
      },
    });

    if (!user || user.status !== RecordStatus.ACTIVE) {
      throw new UnauthorizedException(
        'Account is inactive, suspended, or does not exist.',
      );
    }

    // 3. If email verification purpose, mark email verified
    if (purpose === OtpPurpose.EMAIL_VERIFICATION && !user.emailVerifiedAt) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() },
      });
    }

    // 4. Role codes for JWT
    const roleCodes = user.userRoles.map((ur) => ur.role.code);

    // 5. Generate secure session & refresh token
    const rawRefreshToken = this.generateRawRefreshToken();
    const hashedRefreshToken = this.hashToken(rawRefreshToken);
    const sessionExpiresAt = new Date(
      Date.now() + this.sessionExpiryDays * 24 * 60 * 60 * 1000,
    );

    const session = await this.prisma.userSession.create({
      data: {
        userId: user.id,
        refreshTokenHash: hashedRefreshToken,
        status: SessionStatus.ACTIVE,
        ipAddress: ipAddress || null,
        userAgent: userAgent?.substring(0, 500) || null,
        deviceName: userAgent ? userAgent.substring(0, 150) : null,
        lastUsedAt: new Date(),
        expiresAt: sessionExpiresAt,
      },
    });

    // 6. Sign compact JWT access token
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      userCode: user.userCode,
      userType: user.userType.code,
      roles: roleCodes,
      sessionId: session.id,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.getOrThrow<string>('JWT_SECRET'),
      expiresIn: this.accessTokenExpiry,
    });

    // 7. Audit log successful login
    await this.auditService.logAudit({
      actorUserId: user.id,
      action: AuditAction.LOGIN,
      module: 'auth',
      entityType: 'UserSession',
      entityId: session.id,
      newValues: {
        userId: user.id,
        userCode: user.userCode,
        sessionId: session.id,
      },
      ipAddress,
      userAgent,
    });

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      user: {
        id: user.id,
        userCode: user.userCode,
        name: user.name,
        email: user.email,
        userType: user.userType.code,
      },
    };
  }

  /**
   * Refreshes access token and rotates refresh token.
   */
  async refreshTokens(
    dto: RefreshTokenDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const hashedToken = this.hashToken(dto.refreshToken);

    const session = await this.prisma.userSession.findFirst({
      where: {
        refreshTokenHash: hashedToken,
      },
      include: {
        user: {
          include: {
            userType: true,
            userRoles: {
              include: { role: true },
            },
          },
        },
      },
    });

    if (!session || session.status !== SessionStatus.ACTIVE) {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    if (new Date() > session.expiresAt) {
      await this.prisma.userSession.update({
        where: { id: session.id },
        data: { status: SessionStatus.EXPIRED },
      });
      throw new UnauthorizedException('Refresh token has expired.');
    }

    const { user } = session;
    if (user.status !== RecordStatus.ACTIVE || user.deletedAt !== null) {
      await this.prisma.userSession.update({
        where: { id: session.id },
        data: { status: SessionStatus.REVOKED },
      });
      throw new UnauthorizedException('User account is inactive.');
    }

    // Refresh token rotation
    const newRawRefreshToken = this.generateRawRefreshToken();
    const newHashedRefreshToken = this.hashToken(newRawRefreshToken);
    const newExpiry = new Date(
      Date.now() + this.sessionExpiryDays * 24 * 60 * 60 * 1000,
    );

    await this.prisma.userSession.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: newHashedRefreshToken,
        lastUsedAt: new Date(),
        expiresAt: newExpiry,
        ipAddress: ipAddress || null,
        userAgent: userAgent?.substring(0, 500) || null,
      },
    });

    // Roles
    const roleCodes = user.userRoles.map((ur) => ur.role.code);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      userCode: user.userCode,
      userType: user.userType.code,
      roles: roleCodes,
      sessionId: session.id,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.getOrThrow<string>('JWT_SECRET'),
      expiresIn: this.accessTokenExpiry,
    });

    return {
      accessToken,
      refreshToken: newRawRefreshToken,
    };
  }

  /**
   * Logs out the user from their current active session.
   */
  async logout(
    userId: string,
    sessionId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ message: string }> {
    await this.prisma.userSession.updateMany({
      where: {
        id: sessionId,
        userId,
        status: SessionStatus.ACTIVE,
      },
      data: {
        status: SessionStatus.REVOKED,
        revokedAt: new Date(),
      },
    });

    await this.auditService.logAudit({
      actorUserId: userId,
      action: AuditAction.LOGOUT,
      module: 'auth',
      entityType: 'UserSession',
      entityId: sessionId,
      ipAddress,
      userAgent,
    });

    return { message: 'Logged out successfully.' };
  }

  /**
   * Logs out the user from ALL active sessions across devices.
   */
  async logoutAll(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ message: string }> {
    await this.prisma.userSession.updateMany({
      where: {
        userId,
        status: SessionStatus.ACTIVE,
      },
      data: {
        status: SessionStatus.REVOKED,
        revokedAt: new Date(),
      },
    });

    await this.auditService.logAudit({
      actorUserId: userId,
      action: AuditAction.LOGOUT,
      module: 'auth',
      entityType: 'User',
      entityId: userId,
      newValues: { action: 'LOGOUT_ALL_SESSIONS' },
      ipAddress,
      userAgent,
    });

    return { message: 'All active sessions have been revoked successfully.' };
  }

  /**
   * Fetches profile and effective permissions of current authenticated user.
   */
  async getMe(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: {
        userType: true,
        userRoles: {
          include: { role: true },
        },
        departments: {
          include: { department: true },
        },
        employeeProfile: true,
        clientProfile: true,
      },
    });

    if (!user || user.status !== RecordStatus.ACTIVE) {
      throw new UnauthorizedException('User account is inactive or not found.');
    }

    const permissions = await this.resolveUserPermissions(
      user.id,
      user.userType.code,
    );

    return {
      id: user.id,
      userCode: user.userCode,
      name: user.name,
      email: user.email,
      phone: user.phone,
      emailVerifiedAt: user.emailVerifiedAt,
      status: user.status,
      userType: {
        id: user.userType.id,
        code: user.userType.code,
        name: user.userType.name,
      },
      roles: user.userRoles.map((ur) => ({
        id: ur.role.id,
        code: ur.role.code,
        name: ur.role.name,
      })),
      departments: user.departments.map((ud) => ({
        id: ud.department.id,
        code: ud.department.code,
        name: ud.department.name,
        isPrimary: ud.isPrimary,
      })),
      permissions,
      employeeProfile: user.employeeProfile || null,
      clientProfile: user.clientProfile || null,
      createdAt: user.createdAt,
    };
  }
}

