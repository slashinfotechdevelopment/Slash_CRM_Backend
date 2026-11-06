import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class QueryMyTimeSummaryDto {
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
}

