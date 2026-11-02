import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import * as employeeProfileDto from './employee-profile.dto';

export class UpdateEmployeeProfileDto {
  @ApiPropertyOptional({
    description: 'Unique company employee number / badge code',
    example: 'EMP1001',
  })
  @IsOptional()
  @IsString({ message: 'employeeNumber must be a string.' })
  @MinLength(1, { message: 'employeeNumber cannot be empty string.' })
  @MaxLength(40, { message: 'employeeNumber cannot exceed 40 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  employeeNumber?: string;

  @ApiPropertyOptional({
    description: 'Employee job designation / title',
    example: 'Senior Flutter Developer',
  })
  @IsOptional()
  @IsString({ message: 'designation must be a string.' })
  @MinLength(1, { message: 'designation cannot be empty string.' })
  @MaxLength(120, { message: 'designation cannot exceed 120 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  designation?: string;

  @ApiPropertyOptional({
    description: 'Date of joining (ISO-8601 format YYYY-MM-DD)',
    example: '2026-11-01',
  })
  @IsOptional()
  @IsISO8601(
    { strict: true },
    {
      message:
        'dateOfJoining must be a valid ISO-8601 date string (e.g. 2026-11-01).',
    },
  )
  dateOfJoining?: string;

  @ApiPropertyOptional({
    description: 'Employment type',
    enum: employeeProfileDto.EMPLOYMENT_TYPES,
    example: 'FULL_TIME',
  })
  @IsOptional()
  @IsIn(employeeProfileDto.EMPLOYMENT_TYPES, {
    message: `employmentType must be one of: ${employeeProfileDto.EMPLOYMENT_TYPES.join(', ')}`,
  })
  employmentType?: employeeProfileDto.EmploymentType;

  @ApiPropertyOptional({
    description: 'Reporting manager User ID',
    example: 'cmvw7w8a90001w0twfj2gwx1d',
  })
  @IsOptional()
  @IsString({ message: 'reportingToId must be a string.' })
  @MaxLength(30, { message: 'reportingToId cannot exceed 30 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  reportingToId?: string;

  @ApiPropertyOptional({
    description: 'Internal notes regarding employee',
    example: 'Promoted to Senior Developer',
  })
  @IsOptional()
  @IsString({ message: 'notes must be a string.' })
  @MaxLength(1000, { message: 'notes cannot exceed 1000 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  notes?: string;
}
