import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateUserDto {
  @ApiPropertyOptional({
    description: 'Updated full name of the user',
    example: 'Rahul K. Sharma',
  })
  @IsOptional()
  @IsString({ message: 'name must be a string.' })
  @MinLength(2, { message: 'name must be at least 2 characters long.' })
  @MaxLength(150, { message: 'name cannot exceed 150 characters.' })
  @Matches(/\S/, { message: 'name cannot be blank or whitespace-only.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @ApiPropertyOptional({
    description: 'Updated Indian phone number (+91 followed by 10 digits)',
    example: '+919876543211',
  })
  @IsOptional()
  @IsString({ message: 'phone must be a string.' })
  @Matches(/^\+91[6-9]\d{9}$/, {
    message:
      'phone must be a valid 10-digit Indian phone number prefixed with +91 (e.g. +919876543210).',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  phone?: string;

  @ApiPropertyOptional({
    description: 'Updated profile media ID for avatar',
    example: 'cmvw7w8a90001w0twfj2avatar',
  })
  @IsOptional()
  @IsString({ message: 'profileMediaId must be a string.' })
  @MaxLength(30, { message: 'profileMediaId cannot exceed 30 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  profileMediaId?: string;

  @ApiPropertyOptional({
    description:
      'Nested profile update object corresponding to the user type (EmployeeProfile for EMPLOYEE, ClientProfile for CLIENT)',
  })
  @IsOptional()
  @IsObject({ message: 'profile must be an object if provided.' })
  profile?: Record<string, any>;
}

