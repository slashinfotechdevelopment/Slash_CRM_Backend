import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TriggerReconciliationDto {
  @ApiProperty({
    description: 'Target attendance date to reconcile in YYYY-MM-DD format (Asia/Kolkata business date).',
    example: '2026-11-04',
  })
  @IsNotEmpty()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'targetDate must be formatted as YYYY-MM-DD',
  })
  targetDate: string;

  @ApiPropertyOptional({
    description: 'Optional department ID to reconcile records specifically for that department.',
  })
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional({
    description: 'Force reconciliation even if cutoff grace period has not fully elapsed (requires attendance.force_reconcile).',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  forceReconcile?: boolean;

  @ApiPropertyOptional({
    description: 'Mandatory justification reason when forceReconcile is true.',
    example: 'Emergency executive payroll cutoff override authorized by HR director.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'forceReason cannot exceed 500 characters.' })
  forceReason?: string;

  @ApiPropertyOptional({
    description: 'Optional operational notes for this reconciliation trigger.',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}
