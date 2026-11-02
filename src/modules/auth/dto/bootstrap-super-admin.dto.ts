import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class BootstrapSuperAdminDto {
  @ApiProperty({
    description: 'Full name of the Super Admin',
    example: 'System Administrator',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  @MinLength(2, { message: 'Name must be at least 2 characters long' })
  @MaxLength(150, { message: 'Name cannot exceed 150 characters' })
  name!: string;

  @ApiProperty({
    description: 'Email address of the Super Admin',
    example: 'superadmin@slashinfotech.com',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty({ message: 'Email is required' })
  email!: string;

  @ApiPropertyOptional({
    description: 'Indian mobile number with +91 country code (10 digits following +91)',
    example: '+919876543210',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @Matches(/^\+91[6-9]\d{9}$/, {
    message: 'Phone number must be a valid Indian number formatted as +91XXXXXXXXXX (10 digits starting with 6-9)',
  })
  phone?: string;
}

