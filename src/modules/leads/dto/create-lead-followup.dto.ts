import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { FollowUpStatus } from '../../../generated/prisma/client';

export class CreateLeadFollowUpDto {
  @IsDateString({}, { message: 'scheduledAt must be a valid ISO date-time.' })
  @IsNotEmpty({ message: 'scheduledAt is required.' })
  scheduledAt: string;

  @IsOptional()
  @IsString()
  assignedToId?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateLeadFollowUpDto {
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsEnum(FollowUpStatus)
  status?: FollowUpStatus;

  @IsOptional()
  @IsString()
  note?: string;
}

