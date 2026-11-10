import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  LeadQualificationStatus,
  LeadStatus,
} from '../../../generated/prisma/client';

export class QualifyLeadDto {
  @IsEnum(LeadQualificationStatus, { message: 'qualificationStatus must be PENDING, QUALIFIED, or UNQUALIFIED.' })
  qualificationStatus: LeadQualificationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  unqualifiedReason?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class ChangeLeadStatusDto {
  @IsEnum(LeadStatus, { message: 'status must be NEW, CONTACTED, QUALIFIED, UNQUALIFIED, CONVERTED, or LOST.' })
  status: LeadStatus;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  lostReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  unqualifiedReason?: string;

  @IsOptional()
  @IsString()
  pipelineStageId?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class ConvertLeadDto {
  @IsOptional()
  @IsString()
  note?: string;
}

