import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { LeaveCategory, RecordStatus } from '../../../generated/prisma/enums';

export class UpdateLeaveTypeDto {
  @ApiPropertyOptional({
    description: 'Human-readable name of the leave type',
    example: 'Casual Leave (Updated)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: 'Detailed description of the leave type',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiPropertyOptional({
    description: 'Category of leave: PAID, UNPAID, or COMPENSATORY',
    enum: LeaveCategory,
  })
  @IsOptional()
  @IsEnum(LeaveCategory)
  category?: LeaveCategory;

  @ApiPropertyOptional({
    description: 'Indicates whether leave is paid or unpaid',
  })
  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @ApiPropertyOptional({
    description: 'Record status: ACTIVE or INACTIVE',
    enum: RecordStatus,
  })
  @IsOptional()
  @IsEnum(RecordStatus)
  status?: RecordStatus;
}

