import {
  IsOptional,
  IsString,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsDateString,
  IsBoolean,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import {
  LeadSource,
  LeadPriority,
  LeadStatus,
  LeadQualificationStatus,
} from '../../../generated/prisma/client';

export class QueryLeadsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(LeadStatus)
  status?: LeadStatus;

  @IsOptional()
  @IsEnum(LeadPriority)
  priority?: LeadPriority;

  @IsOptional()
  @IsEnum(LeadSource)
  source?: LeadSource;

  @IsOptional()
  @IsEnum(LeadQualificationStatus)
  qualificationStatus?: LeadQualificationStatus;

  @IsOptional()
  @IsString()
  pipelineStageId?: string;

  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsOptional()
  @IsString()
  assignedToId?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  unassignedOnly?: boolean;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsDateString()
  createdStartDate?: string;

  @IsOptional()
  @IsDateString()
  createdEndDate?: string;

  @IsOptional()
  @IsString()
  sortBy?: 'leadDate' | 'createdAt' | 'leadName' | 'estimatedValue' | 'priority' = 'leadDate';

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc' = 'desc';
}

