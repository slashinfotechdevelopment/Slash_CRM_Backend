import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class QueryEmployeeTasksDto {
  @ApiPropertyOptional({
    description: 'Filter by task status: completed, pending, overdue, or raw status (TODO, IN_PROGRESS, etc.).',
    example: 'overdue',
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({
    description: 'Start date filter (YYYY-MM-DD or ISO string). Default: 30 days ago in Asia/Kolkata.',
    example: '2026-10-15',
  })
  @IsOptional()
  @IsDateString({}, { message: 'from must be a valid date string (YYYY-MM-DD or ISO 8601).' })
  from?: string;

  @ApiPropertyOptional({
    description: 'End date filter (YYYY-MM-DD or ISO string). Default: Current time in Asia/Kolkata.',
    example: '2026-11-14',
  })
  @IsOptional()
  @IsDateString({}, { message: 'to must be a valid date string (YYYY-MM-DD or ISO 8601).' })
  to?: string;

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
}
