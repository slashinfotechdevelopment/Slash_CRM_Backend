import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiProperty({
    description: 'Annual quota allocation in days (e.g. 14.00)',
    example: 14.0,
  })
  @IsNumber()
  @Min(0)
  annualAllocation: number;

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

