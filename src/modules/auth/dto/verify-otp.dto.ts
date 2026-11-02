import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { OtpPurpose } from '../../../generated/prisma/enums';

export class VerifyOtpDto {
  @ApiProperty({
    description: 'User email address',
    example: 'admin@slashinfotech.com',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty({ message: 'Email is required' })
  email!: string;

  @ApiProperty({
    description: '6-digit numeric OTP code',
    example: '123456',
  })
  @IsString({ message: 'OTP must be a string' })
  @IsNotEmpty({ message: 'OTP is required' })
  @Matches(/^[0-9]{6}$/, {
    message: 'OTP must be exactly 6 numeric digits',
  })
  otp!: string;

  @ApiPropertyOptional({
    description: 'Purpose of OTP',
    enum: OtpPurpose,
    default: OtpPurpose.LOGIN,
  })
  @IsOptional()
  @IsEnum(OtpPurpose, {
    message: 'Purpose must be either LOGIN or EMAIL_VERIFICATION',
  })
  purpose?: OtpPurpose = OtpPurpose.LOGIN;
}

