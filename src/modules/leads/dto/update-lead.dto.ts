import {
  IsString,
  IsOptional,
  IsEmail,
  IsEnum,
  IsNumber,
  IsDateString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  LeadSource,
  LeadPriority,
  LeadStatus,
  LeadQualificationStatus,
} from '../../../generated/prisma/client';

export class UpdateLeadDto {
  @IsOptional()
  @IsDateString()
  leadDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  leadName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  alternatePhone?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Invalid email address.' })
  @MaxLength(150)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  companyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  interestedCourse?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  industry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  location?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  pincode?: string;

  @IsOptional()
  @IsString()
  requirementDescription?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  estimatedValue?: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  @IsDateString()
  expectedClosingDate?: string;

  // Independent Feedback Fields
  @IsOptional()
  @IsString()
  feedback1?: string;

  @IsOptional()
  @IsString()
  feedback2?: string;

  @IsOptional()
  @IsString()
  feedback3?: string;

  @IsOptional()
  @IsEnum(LeadSource)
  source?: LeadSource;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  sourceDetails?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  campaignName?: string;

  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsOptional()
  @IsString()
  assignedToId?: string;

  @IsOptional()
  @IsEnum(LeadPriority)
  priority?: LeadPriority;

  @IsOptional()
  @IsEnum(LeadStatus)
  status?: LeadStatus;

  @IsOptional()
  @IsEnum(LeadQualificationStatus)
  qualificationStatus?: LeadQualificationStatus;

  @IsOptional()
  @IsString()
  pipelineStageId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  unqualifiedReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  lostReason?: string;
}

