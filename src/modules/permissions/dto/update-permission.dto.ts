import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RecordStatus } from '../../../generated/prisma/enums';

export class UpdatePermissionDto {
  @ApiPropertyOptional({
    description: 'Human-readable permission name',
    example: 'Create Leads',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters long' })
  @MaxLength(120, { message: 'Name cannot exceed 120 characters' })
  name?: string;

  @ApiPropertyOptional({
    description: 'Detailed description of permission',
    example: 'Grants ability to create new CRM leads',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'Description cannot exceed 255 characters' })
  description?: string;

  @ApiPropertyOptional({
    description: 'Status of permission',
    enum: RecordStatus,
    example: RecordStatus.ACTIVE,
  })
  @IsOptional()
  @IsEnum(RecordStatus, { message: 'Status must be ACTIVE or INACTIVE' })
  status?: RecordStatus;
}

