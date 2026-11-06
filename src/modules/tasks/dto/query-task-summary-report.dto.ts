import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { TaskPriority, TaskStatus } from '../../../generated/prisma/enums';

export class QueryTaskSummaryReportDto {
  @ApiPropertyOptional({
    description: 'Start date for task creation / status interval (YYYY-MM-DD)',
    example: '2026-11-01',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'End date for task creation / status interval (YYYY-MM-DD)',
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
    description: 'Filter by Assignee User ID',
    example: 'usr_emp_001',
  })
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional({
    description: 'Filter by Creator User ID',
    example: 'usr_admin_001',
  })
  @IsOptional()
  @IsString()
  createdById?: string;

  @ApiPropertyOptional({
    description: 'Filter by Task Status',
    enum: TaskStatus,
  })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({
    description: 'Filter by Task Priority',
    enum: TaskPriority,
  })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiPropertyOptional({
    description: 'Filter by Category string',
    example: 'FEATURE',
  })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({
    description: 'Filter only overdue tasks (true/false)',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isOverdue?: boolean;
}

