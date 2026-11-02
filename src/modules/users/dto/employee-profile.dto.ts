import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'INTERN',
  'PROBATION',
] as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export class EmployeeProfileDto {
  @ApiPropertyOptional({
    description: 'Unique company employee number / badge code',
    example: 'EMP1001',
  })
  @IsOptional()
  @IsString({ message: 'employeeNumber must be a string.' })
  @MaxLength(40, { message: 'employeeNumber cannot exceed 40 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  employeeNumber?: string;

  @ApiPropertyOptional({
    description: 'Employee job designation / title',
    example: 'Flutter Developer',
  })
  @IsOptional()
  @IsString({ message: 'designation must be a string.' })
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
    { message: 'dateOfJoining must be a valid ISO-8601 date string (e.g. 2026-11-01).' },
  )
  dateOfJoining?: string;

  @ApiPropertyOptional({
    description: 'Employment type',
    enum: EMPLOYMENT_TYPES,
    example: 'FULL_TIME',
  })
  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES, {
    message: `employmentType must be one of: ${EMPLOYMENT_TYPES.join(', ')}`,
  })
  employmentType?: EmploymentType;

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
    example: 'Development team member',
  })
  @IsOptional()
  @IsString({ message: 'notes must be a string.' })
  @MaxLength(1000, { message: 'notes cannot exceed 1000 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  notes?: string;
}

