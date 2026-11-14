import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LeaveAccrualFrequency } from '../../../generated/prisma/enums';

export class CreatePolicyVersionDto {
  @ApiProperty({
    description: 'Date from which this policy version takes effect (YYYY-MM-DD)',
    example: '2027-01-01',
  })
  @IsString()
  @IsNotEmpty()
  effectiveFrom: string;

  @ApiPropertyOptional({
    description: 'Optional date after which this policy version is superseded (YYYY-MM-DD)',
    example: '2027-12-31',
  })
  @IsOptional()
  @IsString()
  effectiveTo?: string;

  @ApiPropertyOptional({
    description: 'Granting cadence: ANNUAL, MONTHLY, or QUARTERLY',
    enum: LeaveAccrualFrequency,
    default: LeaveAccrualFrequency.ANNUAL,
  })
  @IsOptional()
  @IsEnum(LeaveAccrualFrequency)
  accrualFrequency?: LeaveAccrualFrequency;

  @ApiProperty({
    description: 'Annual quota allocation in days (e.g. 14.00 or 24.00)',
    example: 14.0,
  })
  @IsNumber()
  @Min(0)
  annualAllocation: number;

  @ApiPropertyOptional({
    description: 'Monthly allocation rate when monthly accrual is enabled (e.g. 2.0 days/month)',
    example: 2.0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  monthlyAllocation?: number;

  @ApiPropertyOptional({
    description: 'Maximum days allowed to be taken in any single calendar month (e.g. 2.0)',
    example: 2.0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  maxDaysPerMonth?: number;

  @ApiPropertyOptional({
    description: 'Number of months carry forward remains valid before expiring (e.g. 1, 3, or null)',
    example: 3,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  carryForwardExpiryMonths?: number;

  @ApiPropertyOptional({
    description: 'Maximum consecutive days permitted per application (null = unlimited)',
    example: 7,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxConsecutiveDays?: number;

  @ApiPropertyOptional({
    description: 'Whether half-day requests are allowed under this policy',
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
    description: 'Employment type restriction (null for organization-wide)',
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

