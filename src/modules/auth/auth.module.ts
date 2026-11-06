import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './services/otp.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { DatabaseModule } from '../../database/database.module';
import { EmailModule } from '../../common/email/email.module';
import { AuditModule } from '../../common/audit/audit.module';
import { CommonServicesModule } from '../../common/services/common-services.module';
import { TaskTimerAutoPauseModule } from '../tasks/task-timer-auto-pause.module';

@Module({
  imports: [
    DatabaseModule,
    EmailModule,
    AuditModule,
    CommonServicesModule,
    TaskTimerAutoPauseModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, OtpService, JwtAuthGuard],
  exports: [AuthService, OtpService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}

