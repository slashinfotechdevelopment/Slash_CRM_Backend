import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class UserDepartmentItemDto {
  @ApiProperty({
    description: 'Department code or ID',
    example: 'DEVELOPMENT',
  })
  @IsNotEmpty({ message: 'code is required for department item.' })
  @IsString({ message: 'code must be a string.' })
  @MaxLength(60, { message: 'code cannot exceed 60 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  code!: string;

  @ApiPropertyOptional({
    description: 'Whether this department is the user primary department',
    default: false,
    example: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'isPrimary must be a boolean.' })
  isPrimary?: boolean = false;
}

export class AssignUserDepartmentsDto {
  @ApiProperty({
    description:
      'Array of department items. If non-empty, exactly one item must have isPrimary: true.',
    type: [UserDepartmentItemDto],
    example: [
      { code: 'DEVELOPMENT', isPrimary: true },
      { code: 'MANAGEMENT', isPrimary: false },
    ],
  })
  @IsArray({ message: 'departments must be an array.' })
  @ValidateNested({ each: true })
  @Type(() => UserDepartmentItemDto)
  @ArrayUnique((o: UserDepartmentItemDto) => o.code?.toLowerCase(), {
    message: 'Duplicate departments are not allowed.',
  })
  departments!: UserDepartmentItemDto[];
}

