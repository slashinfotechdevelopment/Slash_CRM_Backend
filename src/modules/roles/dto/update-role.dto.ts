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

export class UpdateRoleDto {
  @ApiPropertyOptional({
    description: 'Human-readable role name',
    example: 'Senior Sales Lead',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Role name must be at least 2 characters long' })
  @MaxLength(100, { message: 'Role name cannot exceed 100 characters' })
  name?: string;

  @ApiPropertyOptional({
    description: 'Role description',
    example: 'Oversees regional and enterprise lead distribution',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'Description cannot exceed 255 characters' })
  description?: string;

  @ApiPropertyOptional({
    description: 'Role record status',
    enum: RecordStatus,
    example: RecordStatus.ACTIVE,
  })
  @IsOptional()
  @IsEnum(RecordStatus, { message: 'Status must be ACTIVE or INACTIVE' })
  status?: RecordStatus;
}

