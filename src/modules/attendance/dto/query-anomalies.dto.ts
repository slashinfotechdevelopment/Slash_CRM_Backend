import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryAnomaliesDto {
  @ApiPropertyOptional({
    description: 'Filter by specific target employee ID (subject to actor data scope).',
  })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({
    description: 'Filter by department ID.',
  })
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional({
    description: 'Filter by specific anomaly type (e.g. MISSING_CHECK_IN, MISSING_CHECK_OUT, OPEN_SESSION, OPEN_BREAK, OVERLAPPING_SESSIONS, etc.).',
  })
  @IsOptional()
  @IsString()
  anomalyType?: string;

  @ApiPropertyOptional({
    description: 'Filter by resolution state (true for resolved anomalies, false for active/unresolved quarantined anomalies).',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsBoolean()
  isResolved?: boolean;

  @ApiPropertyOptional({
    description: 'Filter by attendance date start (YYYY-MM-DD).',
  })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Filter by attendance date end (YYYY-MM-DD).',
  })
  @IsOptional()
  @IsString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

