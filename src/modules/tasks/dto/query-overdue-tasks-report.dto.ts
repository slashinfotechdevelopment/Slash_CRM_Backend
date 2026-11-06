import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { TaskPriority } from '../../../generated/prisma/enums';

export enum OverdueSortBy {
  DUE_DATE = 'dueDate',
  PRIORITY = 'priority',
  CREATED_AT = 'createdAt',
  TITLE = 'title',
}

export enum ReportSortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export class QueryOverdueTasksReportDto {
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
    description: 'Filter by Priority',
    enum: TaskPriority,
  })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiPropertyOptional({
    description: 'Page number for pagination',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Page size for pagination',
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
    description: 'Field to sort by',
    enum: OverdueSortBy,
    default: OverdueSortBy.DUE_DATE,
  })
  @IsOptional()
  @IsEnum(OverdueSortBy)
  sortBy?: OverdueSortBy = OverdueSortBy.DUE_DATE;

  @ApiPropertyOptional({
    description: 'Sort direction',
    enum: ReportSortOrder,
    default: ReportSortOrder.ASC,
  })
  @IsOptional()
  @IsEnum(ReportSortOrder)
  sortOrder?: ReportSortOrder = ReportSortOrder.ASC;
}

