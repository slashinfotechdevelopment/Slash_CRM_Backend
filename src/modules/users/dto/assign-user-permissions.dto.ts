import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { DataScope, PermissionEffect } from '../../../generated/prisma/enums';

export class UserPermissionOverrideItemDto {
  @ApiProperty({
    description: 'Permission code (e.g. leads.view) or permission ID',
    example: 'leads.view',
  })
  @IsNotEmpty({ message: 'code is required.' })
  @IsString({ message: 'code must be a string.' })
  @MaxLength(120, { message: 'code cannot exceed 120 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  code!: string;

  @ApiProperty({
    description: 'Permission override effect (ALLOW or DENY)',
    enum: PermissionEffect,
    example: 'ALLOW',
  })
  @IsNotEmpty({ message: 'effect is required.' })
  @IsEnum(PermissionEffect, {
    message: 'effect must be either ALLOW or DENY.',
  })
  effect!: PermissionEffect;

  @ApiPropertyOptional({
    description: 'Data access scope (required/recommended for ALLOW, null for DENY)',
    enum: DataScope,
    example: 'ASSIGNED',
  })
  @IsOptional()
  @IsEnum(DataScope, {
    message: 'dataScope must be one of: OWN, ASSIGNED, DEPARTMENT, ALL.',
  })
  dataScope?: DataScope;

  @ApiPropertyOptional({
    description: 'Business reason or justification for granting or denying this permission',
    example: 'Special assignment for Q4 regional sales operations',
  })
  @IsOptional()
  @IsString({ message: 'reason must be a string.' })
  @MaxLength(255, { message: 'reason cannot exceed 255 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  reason?: string;
}

export class AssignUserPermissionsDto {
  @ApiProperty({
    description: 'Array of permission override items',
    type: [UserPermissionOverrideItemDto],
    example: [
      {
        code: 'leads.view',
        effect: 'ALLOW',
        dataScope: 'ASSIGNED',
        reason: 'Regional expansion',
      },
      {
        code: 'invoices.approve',
        effect: 'DENY',
        dataScope: null,
        reason: 'Approval authority restricted',
      },
    ],
  })
  @IsArray({ message: 'permissions must be an array.' })
  @ValidateNested({ each: true })
  @Type(() => UserPermissionOverrideItemDto)
  @ArrayUnique((o: UserPermissionOverrideItemDto) => o.code?.toLowerCase(), {
    message: 'Duplicate permission codes are not allowed in permissions array.',
  })
  permissions!: UserPermissionOverrideItemDto[];
}

