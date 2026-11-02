import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { PermissionAssignmentItemDto } from './permission-assignment-item.dto';

export class AssignPermissionsDto {
  @ApiProperty({
    description: 'Complete list of permissions with data scopes to assign to the role',
    type: [PermissionAssignmentItemDto],
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one permission must be provided' })
  @ValidateNested({ each: true })
  @Type(() => PermissionAssignmentItemDto)
  permissions!: PermissionAssignmentItemDto[];
}

