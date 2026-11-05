import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BreakTypeConfigDto {
  @ApiPropertyOptional({
    description: 'Unique break type code (e.g. LUNCH, TEA, PERSONAL)',
    example: 'LUNCH',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;

  @ApiPropertyOptional({
    description: 'Break type identifier alias for code',
    example: 'LUNCH',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  breakTypeId?: string;

  @ApiPropertyOptional({
    description: 'Human-readable name for the break type',
    example: 'Lunch Break',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiProperty({
    description: 'Maximum permitted duration in minutes for this break type',
    example: 60,
  })
  @IsInt()
  @Min(1)
  @Max(360)
  maxDurationMinutes!: number;

  @ApiPropertyOptional({
    description:
      'Whether this break type is paid by default (authoritative duration comes from break policy snapshot)',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @ApiPropertyOptional({
    description: 'Maximum occurrences of this break type allowed per day/shift',
    default: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxOccurrencesPerDay?: number;
}

export class BreakPolicyDto {
  @ApiProperty({
    description:
      'Total daily paid break allowance in minutes across all breaks in the shift',
    example: 60,
  })
  @IsInt()
  @Min(0)
  @Max(360)
  paidAllowanceMinutes!: number;

  @ApiProperty({
    description: 'List of configured break types for this shift',
    type: [BreakTypeConfigDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BreakTypeConfigDto)
  breakTypes!: BreakTypeConfigDto[];
}

