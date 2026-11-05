import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { OvertimeApprovalStatus } from '../../../generated/prisma/enums';

export class QueryOvertimeRequestsDto {
  @ApiPropertyOptional({
    description: 'Filter by specific target employee user ID (scoped by permissions).',
  })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({
    description: 'Filter by request approval status.',
    enum: OvertimeApprovalStatus,
  })
  @IsOptional()
  @IsEnum(OvertimeApprovalStatus)
  status?: OvertimeApprovalStatus;

  @ApiPropertyOptional({
    description: 'Filter by start attendance date (YYYY-MM-DD).',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Filter by end attendance date (YYYY-MM-DD).',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
