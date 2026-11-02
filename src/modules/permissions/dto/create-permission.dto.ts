import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreatePermissionDto {
  @ApiProperty({
    description: 'Unique permission code in module.action format',
    example: 'leads.create',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @IsNotEmpty({ message: 'Permission code is required' })
  @Matches(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, {
    message: 'Permission code must follow module.action format (e.g. leads.view, tasks.assign)',
  })
  @MaxLength(120, { message: 'Code cannot exceed 120 characters' })
  code!: string;

  @ApiProperty({
    description: 'Human-readable permission name',
    example: 'Create Leads',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  @MinLength(2, { message: 'Name must be at least 2 characters long' })
  @MaxLength(120, { message: 'Name cannot exceed 120 characters' })
  name!: string;

  @ApiProperty({
    description: 'System module grouping',
    example: 'leads',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @IsNotEmpty({ message: 'Module is required' })
  @MaxLength(80, { message: 'Module cannot exceed 80 characters' })
  module!: string;

  @ApiProperty({
    description: 'Action within the module',
    example: 'create',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @IsNotEmpty({ message: 'Action is required' })
  @MaxLength(60, { message: 'Action cannot exceed 60 characters' })
  action!: string;

  @ApiPropertyOptional({
    description: 'Detailed description of what this permission grants',
    example: 'Allows creating new sales leads in CRM',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'Description cannot exceed 255 characters' })
  description?: string;
}

