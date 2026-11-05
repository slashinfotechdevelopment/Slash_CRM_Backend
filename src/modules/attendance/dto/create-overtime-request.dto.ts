import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateOvertimeRequestDto {
  @ApiProperty({
    description: 'Attendance calendar date in YYYY-MM-DD format (Asia/Kolkata).',
    example: '2026-11-04',
  })
  @IsNotEmpty()
  @IsDateString()
  attendanceDate: string;

  @ApiProperty({
    description: 'Overtime authorization window start time (ISO 8601 UTC string).',
    example: '2026-11-04T18:00:00.000Z',
  })
  @IsNotEmpty()
  @IsDateString()
  startTime: string;

  @ApiProperty({
    description: 'Overtime authorization window end time (ISO 8601 UTC string).',
    example: '2026-11-04T20:00:00.000Z',
  })
  @IsNotEmpty()
  @IsDateString()
  endTime: string;

  @ApiProperty({
    description: 'Business justification for requesting overtime.',
    example: 'Critical production deployment and customer onboarding support.',
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  reason: string;
}

