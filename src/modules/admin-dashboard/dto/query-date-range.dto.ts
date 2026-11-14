import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class QueryDateRangeDto {
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
}

