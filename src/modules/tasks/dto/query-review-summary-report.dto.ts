import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { TaskReviewOutcome } from '../../../generated/prisma/enums';

export class QueryReviewSummaryReportDto {
  @ApiPropertyOptional({
    description: 'Start date for review submission/completion (YYYY-MM-DD)',
    example: '2026-11-01',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'End date for review submission/completion (YYYY-MM-DD)',
    example: '2026-11-30',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description: 'Filter by Department ID',
    example: 'dept_dev_01',
  })
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional({
    description: 'Filter by Reviewer User ID',
    example: 'usr_pm_001',
  })
  @IsOptional()
  @IsString()
  reviewerId?: string;

  @ApiPropertyOptional({
    description: 'Filter by Submitter User ID',
    example: 'usr_emp_001',
  })
  @IsOptional()
  @IsString()
  submitterId?: string;

  @ApiPropertyOptional({
    description: 'Filter by Review Outcome',
    enum: TaskReviewOutcome,
  })
  @IsOptional()
  @IsEnum(TaskReviewOutcome)
  outcome?: TaskReviewOutcome;
}

