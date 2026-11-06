import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString } from 'class-validator';

export class QueryTaskTimeSummaryDto {
  @ApiPropertyOptional({
    description: 'Filter by start date (YYYY-MM-DD)',
    example: '2026-11-01',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Filter by end date (YYYY-MM-DD)',
    example: '2026-11-05',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description: 'Filter by user ID (Only accessible to authorized supervisors)',
    example: 'cuid1234567890',
  })
  @IsOptional()
  @IsString()
  userId?: string;
}

