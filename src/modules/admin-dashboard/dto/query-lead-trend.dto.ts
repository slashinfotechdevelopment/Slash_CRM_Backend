import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional } from 'class-validator';

export class QueryLeadTrendDto {
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
    description: 'Grouping interval for trend analysis.',
    enum: ['day', 'week', 'month'],
    default: 'day',
  })
  @IsOptional()
  @IsIn(['day', 'week', 'month'], { message: 'interval must be one of: day, week, month.' })
  interval?: 'day' | 'week' | 'month' = 'day';
}

