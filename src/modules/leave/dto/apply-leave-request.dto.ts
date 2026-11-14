import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HalfDayPeriod } from '../../../generated/prisma/enums';

export class ApplyLeaveRequestDto {
  @ApiProperty({
    description: 'Leave Type ID being applied for',
    example: 'clw123leavetype456',
  })
  @IsString()
  @IsNotEmpty()
  leaveTypeId: string;

  @ApiProperty({
    description: 'Leave start date in YYYY-MM-DD format',
    example: '2026-11-20',
  })
  @IsString()
  @IsNotEmpty()
  startDate: string;

  @ApiProperty({
    description: 'Leave end date in YYYY-MM-DD format (must equal startDate for half-day)',
    example: '2026-11-20',
  })
  @IsString()
  @IsNotEmpty()
  endDate: string;

  @ApiPropertyOptional({
    description: 'Whether application is for a half-day',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isHalfDay?: boolean;

  @ApiPropertyOptional({
    description: 'Half day period if isHalfDay is true: FIRST_HALF or SECOND_HALF',
    enum: HalfDayPeriod,
  })
  @IsOptional()
  @IsEnum(HalfDayPeriod)
  halfDayPeriod?: HalfDayPeriod;

  @ApiProperty({
    description: 'Justification and reason for leave',
    example: 'Family wedding attendance and travel.',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({
    description: 'Media ID of uploaded doctor certificate or supporting document',
  })
  @IsOptional()
  @IsString()
  attachmentMediaId?: string;

  @ApiPropertyOptional({
    description: 'Target employee User ID if applied by HR / Manager on behalf of employee',
  })
  @IsOptional()
  @IsString()
  forUserId?: string;
}

