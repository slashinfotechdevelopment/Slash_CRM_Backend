import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { TaskPriority, TaskStatus } from '../../../generated/prisma/enums';

export class UpdateTaskDto {
  @ApiPropertyOptional({
    description: 'Updated task title.',
    example: 'Updated task title',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({
    description: 'Updated task description.',
    example: 'Updated comprehensive description.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Updated task priority level.',
    enum: TaskPriority,
    example: TaskPriority.URGENT,
  })
  @IsOptional()
  @IsEnum(TaskPriority, {
    message: 'priority must be one of: LOW, MEDIUM, HIGH, URGENT.',
  })
  priority?: TaskPriority;

  @ApiPropertyOptional({
    description: 'Updated task workflow status.',
    enum: TaskStatus,
    example: TaskStatus.IN_PROGRESS,
  })
  @IsOptional()
  @IsEnum(TaskStatus, {
    message:
      'status must be one of: TODO, IN_PROGRESS, ON_HOLD, IN_REVIEW, REOPENED, COMPLETED, CANCELLED.',
  })
  status?: TaskStatus;

  @ApiPropertyOptional({
    description: 'Task progress percentage (0 - 100).',
    example: 75,
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;

  @ApiPropertyOptional({
    description: 'Updated task category.',
    example: 'FEATURE',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @ApiPropertyOptional({
    description: 'Updated task start date in YYYY-MM-DD format.',
    example: '2026-11-06',
  })
  @IsOptional()
  @IsDateString({}, { message: 'startDate must be a valid ISO date string (YYYY-MM-DD).' })
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Updated task due date in YYYY-MM-DD format.',
    example: '2026-11-20',
  })
  @IsOptional()
  @IsDateString({}, { message: 'dueDate must be a valid ISO date string (YYYY-MM-DD).' })
  dueDate?: string;

  @ApiPropertyOptional({
    description: 'Updated estimated hours.',
    example: 12.0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  estimatedHours?: number;

  @ApiPropertyOptional({
    description: 'Updated array of tag names. Replaces current tags.',
    example: ['backend', 'reviewed'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({
    description: 'Optional comment explaining the status or field update.',
    example: 'Moved to IN_PROGRESS as development environment is ready.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  statusComment?: string;
}

