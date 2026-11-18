import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { RecordStatus, WorkCalendarScope } from '../../../generated/prisma/enums';

export class UpdateHolidayDto {
  @ApiPropertyOptional({
    description: 'Updated holiday name (e.g. Republic Day, Independence Day)',
    example: 'Republic Day Celebration',
  })
  @IsOptional()
  @IsString({ message: 'Holiday name must be a text string.' })
  @MaxLength(120, { message: 'Holiday name cannot exceed 120 characters.' })
  name?: string;

  @ApiPropertyOptional({
    description: 'Holiday date in YYYY-MM-DD format',
    example: '2026-01-26',
  })
  @IsOptional()
  @IsString({ message: 'Date must be a string formatted as YYYY-MM-DD.' })
  date?: string;

  @ApiPropertyOptional({
    description: 'Calendar year',
    example: 2026,
  })
  @IsOptional()
  @IsNumber({}, { message: 'Year must be a valid number.' })
  year?: number;

  @ApiPropertyOptional({
    description: 'Description or notes for the holiday',
  })
  @IsOptional()
  @IsString({ message: 'Description must be a text string.' })
  @MaxLength(255, { message: 'Description cannot exceed 255 characters.' })
  description?: string;

  @ApiPropertyOptional({
    description: 'Whether this is an optional/restricted holiday',
  })
  @IsOptional()
  @IsBoolean({ message: 'isOptional must be true or false.' })
  isOptional?: boolean;

  @ApiPropertyOptional({
    description: 'Operational status: ACTIVE or INACTIVE (Allows passing/disabling a holiday without permanently deleting it)',
    enum: RecordStatus,
  })
  @IsOptional()
  @IsEnum(RecordStatus, {
    message: 'Status must be either ACTIVE or INACTIVE.',
  })
  status?: RecordStatus;

  @ApiPropertyOptional({
    description: 'Scope: GLOBAL, LOCATION, or DEPARTMENT',
    enum: WorkCalendarScope,
  })
  @IsOptional()
  @IsEnum(WorkCalendarScope, {
    message: 'Scope must be GLOBAL, LOCATION, or DEPARTMENT.',
  })
  scopeType?: WorkCalendarScope;

  @ApiPropertyOptional({
    description: 'Department ID when scope is DEPARTMENT',
  })
  @IsOptional()
  @IsString({ message: 'Department reference must be a valid identifier.' })
  departmentId?: string | null;

  @ApiPropertyOptional({
    description: 'Location name when scope is LOCATION',
    example: 'Chennai',
  })
  @IsOptional()
  @IsString({ message: 'Location must be a text string.' })
  @MaxLength(100, { message: 'Location cannot exceed 100 characters.' })
  location?: string | null;
}
