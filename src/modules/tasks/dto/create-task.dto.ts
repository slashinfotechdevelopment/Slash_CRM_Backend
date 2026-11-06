import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { TaskPriority } from '../../../generated/prisma/enums';

export class CreateTaskDto {
  @ApiProperty({
    description: 'Task title.',
    example: 'Implement task assignment notification handler',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @ApiProperty({
    description: 'Detailed description of the task.',
    example: 'Build email and webhook notification triggers for newly assigned tasks.',
  })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiPropertyOptional({
    description: 'Task priority level.',
    enum: TaskPriority,
    default: TaskPriority.MEDIUM,
    example: TaskPriority.HIGH,
  })
  @IsOptional()
  @IsEnum(TaskPriority, {
    message: 'priority must be one of: LOW, MEDIUM, HIGH, URGENT.',
  })
  priority?: TaskPriority = TaskPriority.MEDIUM;

  @ApiPropertyOptional({
    description: 'Task category classification.',
    default: 'GENERAL',
    example: 'DEVELOPMENT',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string = 'GENERAL';

  @ApiPropertyOptional({
    description: 'Task start date in YYYY-MM-DD format. Defaults to current date if omitted.',
    example: '2026-11-05',
  })
  @IsOptional()
  @IsDateString({}, { message: 'startDate must be a valid ISO date string (YYYY-MM-DD).' })
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Task due date in YYYY-MM-DD format.',
    example: '2026-11-12',
  })
  @IsOptional()
  @IsDateString({}, { message: 'dueDate must be a valid ISO date string (YYYY-MM-DD).' })
  dueDate?: string;

  @ApiPropertyOptional({
    description: 'Estimated effort in hours (up to 2 decimal places).',
    example: 8.5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  estimatedHours?: number;

  @ApiPropertyOptional({
    description:
      'Target assignee User ID. If omitted by an employee creating a personal task, defaults to the creator.',
    example: 'clx01user000123',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  assigneeId?: string;

  @ApiPropertyOptional({
    description: 'Array of tag names to associate with the task.',
    example: ['backend', 'nestjs', 'urgent'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

