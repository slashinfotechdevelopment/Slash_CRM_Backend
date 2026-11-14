import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WorkCalendarScope } from '../../../generated/prisma/enums';

export class CreateWeeklyOffPolicyDto {
  @ApiProperty({
    description: 'Name of the weekly-off policy',
    example: 'Standard Weekend Off (Sat-Sun)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Description of the weekly-off policy',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiProperty({
    description: 'Array of integer days of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)',
    example: [0, 6],
    type: [Number],
  })
  @IsArray()
  @IsNotEmpty()
  daysOfWeek: number[];

  @ApiPropertyOptional({
    description: 'Pattern identifier (ALL = all weeks, ALT_SAT = alternating Saturdays)',
    default: 'ALL',
  })
  @IsOptional()
  @IsString()
  pattern?: string;

  @ApiProperty({
    description: 'Date from which policy becomes effective (YYYY-MM-DD)',
    example: '2026-01-01',
  })
  @IsString()
  @IsNotEmpty()
  effectiveFrom: string;

  @ApiPropertyOptional({
    description: 'Optional date until which policy is effective (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsString()
  effectiveTo?: string;

  @ApiPropertyOptional({
    description: 'Scope: GLOBAL, LOCATION, DEPARTMENT, or USER_OVERRIDE',
    enum: WorkCalendarScope,
    default: WorkCalendarScope.GLOBAL,
  })
  @IsOptional()
  @IsEnum(WorkCalendarScope)
  scopeType?: WorkCalendarScope;

  @ApiPropertyOptional({
    description: 'Department ID if scoped to DEPARTMENT',
  })
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional({
    description: 'Location name if scoped to LOCATION',
    example: 'Bengaluru',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  location?: string;

  @ApiPropertyOptional({
    description: 'User ID if overriding for an individual employee',
  })
  @IsOptional()
  @IsString()
  userId?: string;
}

