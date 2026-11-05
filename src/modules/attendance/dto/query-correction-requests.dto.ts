import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AttendanceCorrectionStatus } from '../../../generated/prisma/enums';

export class QueryCorrectionRequestsDto {
  @ApiPropertyOptional({
    description: 'Filter by specific target employee ID (subject to actor data scope).',
  })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({
    description: 'Filter by specific attendance record ID.',
  })
  @IsOptional()
  @IsString()
  attendanceRecordId?: string;

  @ApiPropertyOptional({
    description: 'Filter by correction request status.',
    enum: AttendanceCorrectionStatus,
  })
  @IsOptional()
  @IsEnum(AttendanceCorrectionStatus)
  status?: AttendanceCorrectionStatus;

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

