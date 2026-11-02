import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { RecordStatus } from '../../../generated/prisma/enums';

export const USER_SORT_FIELDS = [
  'createdAt',
  'name',
  'email',
  'userCode',
  'status',
] as const;

export type UserSortField = (typeof USER_SORT_FIELDS)[number];

export function IsDateRangeValid(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isDateRangeValid',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(_value: any, args: ValidationArguments) {
          const obj = args.object as UserQueryDto;
          if (obj.createdFrom && obj.createdTo) {
            return new Date(obj.createdFrom) <= new Date(obj.createdTo);
          }
          return true;
        },
        defaultMessage() {
          return 'createdFrom date cannot be later than createdTo date.';
        },
      },
    });
  };
}

export class UserQueryDto {
  @ApiPropertyOptional({ description: 'Page number (positive integer)', default: 1 })
  @Type(() => Number)
  @IsInt({ message: 'page must be an integer.' })
  @Min(1, { message: 'page must be at least 1.' })
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Items per page (between 1 and 100)',
    default: 20,
  })
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer.' })
  @Min(1, { message: 'limit must be at least 1.' })
  @Max(100, { message: 'limit cannot exceed 100.' })
  @IsOptional()
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Search term for name, email, or userCode',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'search must be a string.' })
  @MaxLength(100, { message: 'search term cannot exceed 100 characters.' })
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by user type code',
    enum: ['SUPER_ADMIN', 'ADMIN', 'EMPLOYEE', 'CLIENT'],
  })
  @IsIn(['SUPER_ADMIN', 'ADMIN', 'EMPLOYEE', 'CLIENT'], {
    message: 'userType must be one of: SUPER_ADMIN, ADMIN, EMPLOYEE, CLIENT.',
  })
  @IsOptional()
  userType?: string;

  @ApiPropertyOptional({
    description: 'Filter by role code or role ID',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'role must be a string.' })
  @MaxLength(60, { message: 'role cannot exceed 60 characters.' })
  @IsOptional()
  role?: string;

  @ApiPropertyOptional({
    description: 'Filter by department code or department ID',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'department must be a string.' })
  @MaxLength(60, { message: 'department cannot exceed 60 characters.' })
  @IsOptional()
  department?: string;

  @ApiPropertyOptional({
    description: 'Filter by status (ACTIVE / INACTIVE)',
    enum: RecordStatus,
  })
  @IsEnum(RecordStatus, {
    message: 'status must be a valid RecordStatus (ACTIVE, INACTIVE).',
  })
  @IsOptional()
  status?: RecordStatus;

  @ApiPropertyOptional({
    description: 'Filter by email verification state (true / false)',
  })
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  @IsBoolean({ message: 'emailVerified must be a boolean (true or false).' })
  @IsOptional()
  emailVerified?: boolean;

  @ApiPropertyOptional({
    description: 'Filter created after ISO-8601 timestamp (YYYY-MM-DD or full ISO)',
  })
  @IsISO8601({}, { message: 'createdFrom must be a valid ISO-8601 date string.' })
  @IsOptional()
  createdFrom?: string;

  @ApiPropertyOptional({
    description: 'Filter created before ISO-8601 timestamp (YYYY-MM-DD or full ISO)',
  })
  @IsISO8601({}, { message: 'createdTo must be a valid ISO-8601 date string.' })
  @IsDateRangeValid()
  @IsOptional()
  createdTo?: string;

  @ApiPropertyOptional({
    description: 'Field to sort by',
    enum: USER_SORT_FIELDS,
    default: 'createdAt',
  })
  @IsIn(USER_SORT_FIELDS, {
    message: `sortBy must be one of: ${USER_SORT_FIELDS.join(', ')}.`,
  })
  @IsOptional()
  sortBy?: UserSortField = 'createdAt';

  @ApiPropertyOptional({
    description: 'Sort direction (ASC or DESC)',
    enum: ['ASC', 'DESC'],
    default: 'DESC',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? (value.toUpperCase() as 'ASC' | 'DESC') : value,
  )
  @IsIn(['ASC', 'DESC'], { message: 'sortOrder must be either ASC or DESC.' })
  @IsOptional()
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

