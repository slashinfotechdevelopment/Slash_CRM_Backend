import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WorkCalendarScope } from '../../../generated/prisma/enums';

export class CreateHolidayDto {
  @ApiProperty({
    description: 'Name of the holiday (e.g. Republic Day, Diwali)',
    example: 'Republic Day',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({
    description: 'Holiday date in YYYY-MM-DD format',
    example: '2026-01-26',
  })
  @IsString()
  @IsNotEmpty()
  date: string;

  @ApiPropertyOptional({
    description: 'Calendar year (defaults to year parsed from date)',
    example: 2026,
  })
  @IsOptional()
  @IsNumber()
  year?: number;

  @ApiPropertyOptional({
    description: 'Optional description or cultural context',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiPropertyOptional({
    description: 'Whether this is an optional/restricted holiday',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isOptional?: boolean;

  @ApiPropertyOptional({
    description: 'Calendar scope: GLOBAL, LOCATION, or DEPARTMENT',
    enum: WorkCalendarScope,
    default: WorkCalendarScope.GLOBAL,
  })
  @IsOptional()
  @IsEnum(WorkCalendarScope)
  scopeType?: WorkCalendarScope;

  @ApiPropertyOptional({
    description: 'Department ID when scope is DEPARTMENT',
  })
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional({
    description: 'Location name/code when scope is LOCATION',
    example: 'Bengaluru',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  location?: string;
}

