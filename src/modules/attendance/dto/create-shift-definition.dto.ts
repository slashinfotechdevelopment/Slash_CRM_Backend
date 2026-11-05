import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BreakPolicyDto } from './break-policy.dto';

export class CreateShiftDefinitionDto {
  @ApiProperty({
    description: 'Unique shift code identifier (e.g. GENERAL_09_18, NIGHT_22_06)',
    example: 'GENERAL_09_18',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code!: string;

  @ApiProperty({
    description: 'Descriptive human-readable shift name',
    example: 'General Day Shift (9 AM - 6 PM)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description: 'Scheduled shift start time in HH:mm 24-hour format',
    example: '09:00',
  })
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'startTime must be in valid HH:mm 24-hour format (e.g. 09:00)',
  })
  startTime!: string;

  @ApiProperty({
    description: 'Scheduled shift end time in HH:mm 24-hour format',
    example: '18:00',
  })
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'endTime must be in valid HH:mm 24-hour format (e.g. 18:00)',
  })
  endTime!: string;

  @ApiPropertyOptional({
    description:
      'Whether the shift spans across calendar midnight (e.g. 22:00 to 06:00)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isOvernight?: boolean;

  @ApiPropertyOptional({
    description:
      'Grace period in minutes after scheduled start before attendance is marked late',
    default: 15,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(180)
  gracePeriodMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Minimum net working minutes required for half-day attendance credit',
    default: 240,
  })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(720)
  halfDayThresholdMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Minimum net working minutes required for full-day attendance credit',
    default: 480,
  })
  @IsOptional()
  @IsInt()
  @Min(120)
  @Max(1440)
  fullDayThresholdMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Net working minutes threshold after which overtime begins accumulating',
    default: 540,
  })
  @IsOptional()
  @IsInt()
  @Min(120)
  @Max(1440)
  overtimeThresholdMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Whether multiple attendance sessions are permitted within a single working day',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  allowMultipleSessions?: boolean;

  @ApiPropertyOptional({
    description:
      'Grace period in minutes after scheduled shift end before automated EOD closure runs',
    default: 30,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(360)
  autoCloseGraceMinutes?: number;

  @ApiPropertyOptional({
    description: 'Structured break policy definition for the shift',
    type: BreakPolicyDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => BreakPolicyDto)
  breakPolicy?: BreakPolicyDto;

  @ApiPropertyOptional({
    description: 'Raw break policy snapshot JSON string or object representation',
  })
  @IsOptional()
  breakPolicySnapshot?: string | BreakPolicyDto;
}

