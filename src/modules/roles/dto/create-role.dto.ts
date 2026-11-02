import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PermissionAssignmentItemDto } from './permission-assignment-item.dto';

export class CreateRoleDto {
  @ApiProperty({
    description: 'Unique uppercase role code with underscores',
    example: 'REGIONAL_MANAGER',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @IsNotEmpty({ message: 'Role code is required' })
  @Matches(/^[A-Z0-9_]+$/, {
    message: 'Role code must be uppercase alphanumeric with underscores only (e.g. SALES_LEAD)',
  })
  @MinLength(2, { message: 'Role code must be at least 2 characters long' })
  @MaxLength(60, { message: 'Role code cannot exceed 60 characters' })
  code!: string;

  @ApiProperty({
    description: 'Human-readable role name',
    example: 'Regional Manager',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'Role name is required' })
  @MinLength(2, { message: 'Role name must be at least 2 characters long' })
  @MaxLength(100, { message: 'Role name cannot exceed 100 characters' })
  name!: string;

  @ApiPropertyOptional({
    description: 'Detailed description of role responsibilities',
    example: 'Manages sales and team operations across regions',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'Description cannot exceed 255 characters' })
  description?: string;

  @ApiPropertyOptional({
    description: 'Optional initial list of permissions with data scopes',
    type: [PermissionAssignmentItemDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PermissionAssignmentItemDto)
  permissions?: PermissionAssignmentItemDto[];
}

