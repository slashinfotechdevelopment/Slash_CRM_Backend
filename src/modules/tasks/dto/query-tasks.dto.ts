import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { TaskPriority, TaskStatus } from '../../../generated/prisma/enums';

export enum TaskSortBy {
  CREATED_AT = 'createdAt',
  UPDATED_AT = 'updatedAt',
  DUE_DATE = 'dueDate',
  START_DATE = 'startDate',
  PRIORITY = 'priority',
  STATUS = 'status',
  TITLE = 'title',
  TASK_CODE = 'taskCode',
}

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export class QueryTasksDto {
  @ApiPropertyOptional({
    description: 'Page number for pagination.',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Number of items per page.',
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Search string matched against task code, title, and description.',
    example: 'TASK001',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by task status.',
    enum: TaskStatus,
  })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({
    description: 'Filter by task priority.',
    enum: TaskPriority,
  })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiPropertyOptional({
    description: 'Filter by category name.',
    example: 'DEVELOPMENT',
  })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({
    description: 'Filter by assignee User ID.',
    example: 'clx01employee0001',
  })
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional({
    description: 'Filter by creator User ID.',
    example: 'clx01admin0001',
  })
  @IsOptional()
  @IsString()
  createdById?: string;

  @ApiPropertyOptional({
    description: 'Filter by department ID.',
    example: 'clx01dept0001',
  })
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional({
    description: 'Filter by start date on or after (YYYY-MM-DD).',
    example: '2026-11-01',
  })
  @IsOptional()
  @IsDateString()
  startDateFrom?: string;

  @ApiPropertyOptional({
    description: 'Filter by start date on or before (YYYY-MM-DD).',
    example: '2026-11-30',
  })
  @IsOptional()
  @IsDateString()
  startDateTo?: string;

  @ApiPropertyOptional({
    description: 'Filter by due date on or after (YYYY-MM-DD).',
    example: '2026-11-01',
  })
  @IsOptional()
  @IsDateString()
  dueDateFrom?: string;

  @ApiPropertyOptional({
    description: 'Filter by due date on or before (YYYY-MM-DD).',
    example: '2026-11-30',
  })
  @IsOptional()
  @IsDateString()
  dueDateTo?: string;

  @ApiPropertyOptional({
    description: 'Filter for overdue tasks (due date past today and not completed/cancelled).',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isOverdue?: boolean;

  @ApiPropertyOptional({
    description: 'Field to sort tasks by.',
    enum: TaskSortBy,
    default: TaskSortBy.CREATED_AT,
  })
  @IsOptional()
  @IsEnum(TaskSortBy)
  sortBy?: TaskSortBy = TaskSortBy.CREATED_AT;

  @ApiPropertyOptional({
    description: 'Sort direction.',
    enum: SortOrder,
    default: SortOrder.DESC,
  })
  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder = SortOrder.DESC;
}

