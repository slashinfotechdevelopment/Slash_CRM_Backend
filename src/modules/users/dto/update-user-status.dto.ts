import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { RecordStatus } from '../../../generated/prisma/enums';

export class UpdateUserStatusDto {
  @ApiProperty({
    description: 'New account operational status',
    enum: RecordStatus,
    example: 'INACTIVE',
  })
  @IsNotEmpty({ message: 'status is required.' })
  @IsEnum(RecordStatus, {
    message: 'status must be a valid RecordStatus (ACTIVE or INACTIVE).',
  })
  status!: RecordStatus;

  @ApiPropertyOptional({
    description: 'Reason for the status change',
    example: 'Employee resigned from the organization',
  })
  @IsOptional()
  @IsString({ message: 'reason must be a string.' })
  @MaxLength(500, { message: 'reason cannot exceed 500 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  reason?: string;
}

