import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsNotEmpty, IsOptional } from 'class-validator';
import { OtpPurpose } from '../../../generated/prisma/enums';

export class SendOtpDto {
  @ApiProperty({
    description: 'User email address',
    example: 'admin@slashinfotech.com',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty({ message: 'Email is required' })
  email!: string;

  @ApiPropertyOptional({
    description: 'Purpose of OTP request',
    enum: OtpPurpose,
    default: OtpPurpose.LOGIN,
  })
  @IsOptional()
  @IsEnum(OtpPurpose, {
    message: 'Purpose must be either LOGIN or EMAIL_VERIFICATION',
  })
  purpose?: OtpPurpose = OtpPurpose.LOGIN;
}

