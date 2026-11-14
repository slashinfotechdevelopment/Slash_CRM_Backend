import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LeaveCategory } from '../../../generated/prisma/enums';

export class CreateLeaveTypeDto {
  @ApiProperty({
    description: 'Unique immutable business code for the leave type (e.g. CASUAL, SICK, EARNED, LOP)',
    example: 'CASUAL',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code: string;

  @ApiProperty({
    description: 'Human-readable name of the leave type',
    example: 'Casual Leave',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Detailed description of the leave type',
    example: 'Short-term casual absence for personal or family needs.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiPropertyOptional({
    description: 'Category of leave: PAID, UNPAID, or COMPENSATORY',
    enum: LeaveCategory,
    default: LeaveCategory.PAID,
  })
  @IsOptional()
  @IsEnum(LeaveCategory)
  category?: LeaveCategory;

  @ApiPropertyOptional({
    description: 'Indicates whether leave is paid or unpaid (Loss of Pay)',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  // Initial Policy Version Parameters
  @ApiPropertyOptional({
    description: 'Annual quota allocation in days (e.g. 12.00)',
    example: 12.0,
    default: 12.0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  annualAllocation?: number;

  @ApiPropertyOptional({
    description: 'Maximum consecutive days permitted per application (null = unlimited)',
    example: 5,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxConsecutiveDays?: number;

  @ApiPropertyOptional({
    description: 'Whether half-day requests are allowed',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  allowHalfDay?: boolean;

  @ApiPropertyOptional({
    description: 'Whether supporting medical or justification documentation is mandatory',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  requiresDocument?: boolean;

  @ApiPropertyOptional({
    description: 'Minimum notice period in calendar days prior to leave start date',
    default: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minNoticeDays?: number;

  @ApiPropertyOptional({
    description: 'Maximum days that can carry forward to the subsequent fiscal year',
    default: 0.0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  carryForwardLimit?: number;

  @ApiPropertyOptional({
    description: 'Whether weekly-off days within the leave window are excluded from consumption',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  excludeWeeklyOffs?: boolean;

  @ApiPropertyOptional({
    description: 'Whether holidays within the leave window are excluded from consumption',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  excludeHolidays?: boolean;

  @ApiPropertyOptional({
    description: 'Employment type restriction (e.g. FULL_TIME, PROBATION, CONTRACT, or null for all)',
  })
  @IsOptional()
  @IsString()
  applicableEmploymentType?: string;

  @ApiPropertyOptional({
    description: 'Department ID restriction (null for organization-wide)',
  })
  @IsOptional()
  @IsString()
  departmentId?: string;
}

