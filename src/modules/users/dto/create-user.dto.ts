import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { IsValidUserProfile } from './is-valid-user-profile.decorator';

export const ALLOWED_CREATABLE_USER_TYPES = [
  'ADMIN',
  'EMPLOYEE',
  'CLIENT',
] as const;

export type CreatableUserType = (typeof ALLOWED_CREATABLE_USER_TYPES)[number];

export class CreateUserDto {
  @ApiProperty({
    description: 'Category of account to create (ADMIN, EMPLOYEE, CLIENT)',
    enum: ALLOWED_CREATABLE_USER_TYPES,
    example: 'EMPLOYEE',
  })
  @IsNotEmpty({ message: 'userType is required.' })
  @IsString({ message: 'userType must be a string.' })
  @IsIn(ALLOWED_CREATABLE_USER_TYPES, {
    message: `userType must be one of: ${ALLOWED_CREATABLE_USER_TYPES.join(', ')}. Super Admin cannot be created via ordinary user creation.`,
  })
  userType!: CreatableUserType;

  @ApiProperty({
    description: 'Full legal name of the user',
    example: 'Rahul Kumar',
  })
  @IsNotEmpty({ message: 'name is required.' })
  @IsString({ message: 'name must be a string.' })
  @MinLength(2, { message: 'name must be at least 2 characters long.' })
  @MaxLength(150, { message: 'name cannot exceed 150 characters.' })
  @Matches(/\S/, { message: 'name cannot be blank or whitespace-only.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiProperty({
    description: 'Unique corporate or personal email address',
    example: 'rahul@example.com',
  })
  @IsNotEmpty({ message: 'email is required.' })
  @IsEmail({}, { message: 'email must be a valid email address.' })
  @MaxLength(191, { message: 'email cannot exceed 191 characters.' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiPropertyOptional({
    description: 'Indian mobile number (+91 followed by 10 digits starting with 6-9)',
    example: '+919876543210',
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
    description: 'Array of role codes or IDs to assign to the user',
    example: ['DEVELOPER'],
    type: [String],
  })
  @IsOptional()
  @IsArray({ message: 'roles must be an array of role codes or IDs.' })
  @IsString({ each: true, message: 'Each role item must be a string.' })
  @ArrayUnique({ message: 'Duplicate roles are not allowed in roles array.' })
  roles?: string[];

  @ApiPropertyOptional({
    description: 'Array of department codes or IDs to assign to the user',
    example: ['DEVELOPMENT'],
    type: [String],
  })
  @IsOptional()
  @IsArray({ message: 'departments must be an array of department codes or IDs.' })
  @IsString({ each: true, message: 'Each department item must be a string.' })
  @ArrayUnique({
    message: 'Duplicate departments are not allowed in departments array.',
  })
  departments?: string[];

  @ApiPropertyOptional({
    description:
      'Dynamic profile object matching the userType (EmployeeProfile for EMPLOYEE, ClientProfile for CLIENT, disallowed for ADMIN)',
  })
  @IsValidUserProfile()
  profile?: Record<string, any>;
}

