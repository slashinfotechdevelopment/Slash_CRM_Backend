import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString } from 'class-validator';

export class QueryTaskDashboardDto {
  @ApiPropertyOptional({
    description: 'Start date filter for dashboard time summaries (YYYY-MM-DD)',
    example: '2026-11-01',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'End date filter for dashboard time summaries (YYYY-MM-DD)',
    example: '2026-11-30',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description: 'Department ID filter (requires authorized scope)',
    example: 'dept_dev_01',
  })
  @IsOptional()
  @IsString()
  departmentId?: string;
}

