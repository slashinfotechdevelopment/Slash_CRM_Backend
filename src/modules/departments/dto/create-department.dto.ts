import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RecordStatus } from '../../../generated/prisma/enums';

export class CreateDepartmentDto {
  @ApiProperty({
    description: 'Unique department code (uppercase alphanumeric with underscores)',
    example: 'MARKETING',
  })
  @IsString({ message: 'Department code must be a text string.' })
  @IsNotEmpty({ message: 'Department code is required.' })
  @MinLength(2, { message: 'Department code must be at least 2 characters long.' })
  @MaxLength(40, { message: 'Department code cannot exceed 40 characters.' })
  @Matches(/^[A-Z0-9_]+$/, {
    message: 'Department code must contain only uppercase letters, numbers, and underscores (e.g. MARKETING, IT_OPS).',
  })
  code: string;

  @ApiProperty({
    description: 'Human-readable department name',
    example: 'Marketing & Communications',
  })
  @IsString({ message: 'Department name must be a text string.' })
  @IsNotEmpty({ message: 'Department name is required.' })
  @MinLength(2, { message: 'Department name must be at least 2 characters long.' })
  @MaxLength(120, { message: 'Department name cannot exceed 120 characters.' })
  name: string;

  @ApiPropertyOptional({
    description: 'Optional description of the department and its scope',
    example: 'Handles company branding, campaigns, and lead generation.',
  })
  @IsOptional()
  @IsString({ message: 'Description must be a text string.' })
  @MaxLength(255, { message: 'Description cannot exceed 255 characters.' })
  description?: string;

  @ApiPropertyOptional({
    description: 'Parent department ID for organizational hierarchy (e.g. Frontend under Development)',
  })
  @IsOptional()
  @IsString({ message: 'Parent department reference must be a valid identifier.' })
  parentId?: string;

  @ApiPropertyOptional({
    description: 'Operational status of the department',
    enum: RecordStatus,
    default: RecordStatus.ACTIVE,
  })
  @IsOptional()
  @IsEnum(RecordStatus, {
    message: 'Status must be either ACTIVE or INACTIVE.',
  })
  status?: RecordStatus;
}
