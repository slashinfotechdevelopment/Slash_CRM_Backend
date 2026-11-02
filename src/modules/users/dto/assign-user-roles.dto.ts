import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, ArrayUnique, IsArray, IsString } from 'class-validator';

export class AssignUserRolesDto {
  @ApiProperty({
    description: 'Array of role codes or role IDs to assign',
    example: ['DEVELOPER', 'PROJECT_MANAGER'],
    type: [String],
  })
  @IsArray({ message: 'roles must be an array of role codes or IDs.' })
  @ArrayNotEmpty({ message: 'roles array cannot be empty.' })
  @IsString({ each: true, message: 'Each role item must be a string.' })
  @ArrayUnique({ message: 'Duplicate roles are not allowed in roles array.' })
  roles!: string[];
}

