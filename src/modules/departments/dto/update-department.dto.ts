import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { RecordStatus } from '../../../generated/prisma/enums';

export class UpdateDepartmentDto {
  @ApiPropertyOptional({
    description: 'Updated human-readable department name',
    example: 'Marketing, PR & Communications',
  })
  @IsOptional()
  @IsString({ message: 'Department name must be a text string.' })
  @MinLength(2, { message: 'Department name must be at least 2 characters long.' })
  @MaxLength(120, { message: 'Department name cannot exceed 120 characters.' })
  name?: string;

  @ApiPropertyOptional({
    description: 'Updated description of the department',
    example: 'Oversees global brand marketing, content, and communications.',
  })
  @IsOptional()
  @IsString({ message: 'Description must be a text string.' })
  @MaxLength(255, { message: 'Description cannot exceed 255 characters.' })
  description?: string;

  @ApiPropertyOptional({
    description: 'Parent department ID for organizational hierarchy (null to unassign parent)',
  })
  @IsOptional()
  @IsString({ message: 'Parent department reference must be a valid identifier.' })
  parentId?: string | null;

  @ApiPropertyOptional({
    description: 'Operational status of the department (ACTIVE or INACTIVE)',
    enum: RecordStatus,
  })
  @IsOptional()
  @IsEnum(RecordStatus, {
    message: 'Status must be either ACTIVE or INACTIVE.',
  })
  status?: RecordStatus;
}
