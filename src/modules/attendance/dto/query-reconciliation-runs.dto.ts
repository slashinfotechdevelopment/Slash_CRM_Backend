import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ReconciliationRunStatus } from '../../../generated/prisma/enums';

export class QueryReconciliationRunsDto {
  @ApiPropertyOptional({
    description: 'Filter by target attendance date (YYYY-MM-DD).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'targetDate must be formatted as YYYY-MM-DD',
  })
  targetDate?: string;

  @ApiPropertyOptional({
    description: 'Filter by reconciliation run status.',
    enum: ReconciliationRunStatus,
  })
  @IsOptional()
  @IsEnum(ReconciliationRunStatus)
  status?: ReconciliationRunStatus;

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

