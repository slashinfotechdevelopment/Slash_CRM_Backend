import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { LeadActivityType } from '../../../generated/prisma/client';

export class CreateLeadActivityDto {
  @IsEnum(LeadActivityType, { message: 'type must be NOTE, CALL, MEETING, EMAIL, STATUS_CHANGE, ASSIGNMENT, or QUALIFICATION.' })
  type: LeadActivityType;

  @IsString()
  @IsNotEmpty({ message: 'title is required.' })
  @MaxLength(150)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  metadata?: any;
}

