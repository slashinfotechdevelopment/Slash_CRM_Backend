import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AssignShiftDto {
  @ApiProperty({
    description: 'Target employee user ID to whom the shift is being assigned',
    example: 'user_emp1234567890',
  })
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @ApiProperty({
    description: 'Shift definition ID to assign',
    example: 'cuid_shift_gen_01',
  })
  @IsString()
  @IsNotEmpty()
  shiftDefinitionId!: string;

  @ApiProperty({
    description:
      'Calendar start date of the shift assignment in YYYY-MM-DD or ISO 8601 format',
    example: '2026-11-01',
  })
  @IsNotEmpty()
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({
    description:
      'Optional calendar end date of the shift assignment. If null/omitted, assignment is open-ended.',
    example: '2026-12-31',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class UpdateShiftAssignmentDto {
  @ApiPropertyOptional({
    description: 'Updated shift definition ID',
  })
  @IsOptional()
  @IsString()
  shiftDefinitionId?: string;

  @ApiPropertyOptional({
    description:
      'Updated start date in YYYY-MM-DD or ISO 8601 format',
    example: '2026-11-01',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description:
      'Updated end date in YYYY-MM-DD or ISO 8601 format (null/empty to leave open-ended)',
    example: '2026-12-31',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

