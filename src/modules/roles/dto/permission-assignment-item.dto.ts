import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { DataScope } from '../../../generated/prisma/enums';

export class PermissionAssignmentItemDto {
  @ApiProperty({
    description: 'Valid Permission ID',
    example: 'cmvw7...',
  })
  @IsString()
  @IsNotEmpty({ message: 'Permission ID is required' })
  permissionId!: string;

  @ApiPropertyOptional({
    description: 'Data scope for this permission',
    enum: DataScope,
    default: DataScope.ALL,
  })
  @IsOptional()
  @IsEnum(DataScope, { message: 'Invalid data scope' })
  dataScope?: DataScope = DataScope.ALL;
}

