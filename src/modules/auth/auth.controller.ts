import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { BootstrapSuperAdminDto } from './dto/bootstrap-super-admin.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import type { JwtPayload } from './auth.service';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('bootstrap-super-admin')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'One-time initial bootstrap to create the system Super Admin',
    description:
      'Creates the initial Super Admin account and sends an email verification code. This endpoint is permanently disabled after the first Super Admin is created.',
  })
  @ApiResponse({
    status: 201,
    description: 'Super Admin initialized successfully. Verification OTP sent.',
  })
  @ApiResponse({
    status: 403,
    description: 'Super Admin already initialized.',
  })
  async bootstrapSuperAdmin(
    @Body() dto: BootstrapSuperAdminDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const data = await this.authService.bootstrapSuperAdmin(
      dto,
      ip,
      userAgent,
    );
    return {
      success: true,
      message:
        'Super Admin initialized successfully. A verification code has been sent to your email. Please verify your email to complete setup.',
      data,
    };
  }

  @Public()
  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a 6-digit OTP for login or email verification',
    description:
      'Generates a single-use 6-digit OTP and delivers it via Hostinger SMTP. Enforces 60-second resend cooldown.',
  })
  @ApiResponse({
    status: 200,
    description: 'OTP dispatched successfully.',
  })
  @ApiResponse({
    status: 429,
    description: 'Resend cooldown active.',
  })
  async sendOtp(
    @Body() dto: SendOtpDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const result = await this.authService.sendOtp(dto, ip, userAgent);
    return {
      success: true,
      message: result.message,
    };
  }

  @Public()
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify 6-digit OTP and issue JWT access token and refresh token',
    description:
      'Validates OTP with max 5 attempts limit and constant-time comparison. Upon success, creates a session and returns auth tokens.',
  })
  @ApiResponse({
    status: 200,
    description: 'OTP verified successfully. Tokens issued.',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or expired OTP code.',
  })
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const data = await this.authService.verifyOtp(dto, ip, userAgent);
    return {
      success: true,
      message: 'Authentication successful.',
      data,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate refresh token and issue new access token',
    description:
      'Validates active refresh token session and rotates the token safely.',
  })
  @ApiResponse({
    status: 200,
    description: 'Tokens rotated successfully.',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or expired refresh token.',
  })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const data = await this.authService.refreshTokens(dto, ip, userAgent);
    return {
      success: true,
      message: 'Tokens rotated successfully.',
      data,
    };
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Logout current session',
    description: 'Revokes the current active session in database.',
  })
  @ApiResponse({
    status: 200,
    description: 'Current session revoked successfully.',
  })
  async logout(
    @CurrentUser() user: JwtPayload,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const result = await this.authService.logout(
      user.sub,
      user.sessionId,
      ip,
      userAgent,
    );
    return {
      success: true,
      message: result.message,
    };
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Logout from all devices',
    description: 'Revokes all active sessions for the authenticated user.',
  })
  @ApiResponse({
    status: 200,
    description: 'All user sessions revoked successfully.',
  })
  async logoutAll(
    @CurrentUser() user: JwtPayload,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const result = await this.authService.logoutAll(user.sub, ip, userAgent);
    return {
      success: true,
      message: result.message,
    };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Get current authenticated user profile and permissions',
    description:
      'Fetches the user details, assigned roles, and effective permission keys.',
  })
  @ApiResponse({
    status: 200,
    description: 'User profile retrieved successfully.',
  })
  async getMe(@CurrentUser() user: JwtPayload) {
    const data = await this.authService.getMe(user.sub);
    return {
      success: true,
      message: 'Profile retrieved successfully.',
      data,
    };
  }
}

