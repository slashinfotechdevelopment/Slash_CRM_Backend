import {
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum CorrectionType {
  MISSED_CHECK_IN = 'MISSED_CHECK_IN',
  MISSED_CHECK_OUT = 'MISSED_CHECK_OUT',
  INCORRECT_CHECK_IN = 'INCORRECT_CHECK_IN',
  INCORRECT_CHECK_OUT = 'INCORRECT_CHECK_OUT',
  INCORRECT_BREAK = 'INCORRECT_BREAK',
  OTHER = 'OTHER',
}

export class CreateCorrectionRequestDto {
  @ApiProperty({
    description: 'Attendance date in YYYY-MM-DD format.',
    example: '2026-11-04',
  })
  @IsString()
  @IsNotEmpty()
  attendanceDate: string;

  @ApiPropertyOptional({
    description: 'Affected AttendanceSession ID if correcting an existing session.',
    example: 'cmw123session456',
  })
  @IsOptional()
  @IsString()
  attendanceSessionId?: string;

  @ApiPropertyOptional({
    description: 'Affected AttendanceBreak ID if correcting a break interval.',
    example: 'cmw123break456',
  })
  @IsOptional()
  @IsString()
  attendanceBreakId?: string;

  @ApiProperty({
    description: 'Type of attendance correction requested.',
    enum: CorrectionType,
    example: CorrectionType.INCORRECT_CHECK_OUT,
  })
  @IsEnum(CorrectionType, {
    message:
      'correctionType must be one of: MISSED_CHECK_IN, MISSED_CHECK_OUT, INCORRECT_CHECK_IN, INCORRECT_CHECK_OUT, INCORRECT_BREAK, OTHER.',
  })
  correctionType: CorrectionType;

  @ApiPropertyOptional({
    description: 'Requested corrected check-in timestamp in ISO 8601 UTC format.',
    example: '2026-11-04T03:30:00.000Z',
  })
  @IsOptional()
  @IsISO8601({}, { message: 'requestedCheckInAt must be a valid ISO 8601 UTC timestamp.' })
  requestedCheckInAt?: string;

  @ApiPropertyOptional({
    description: 'Requested corrected check-out timestamp in ISO 8601 UTC format.',
    example: '2026-11-04T12:30:00.000Z',
  })
  @IsOptional()
  @IsISO8601({}, { message: 'requestedCheckOutAt must be a valid ISO 8601 UTC timestamp.' })
  requestedCheckOutAt?: string;

  @ApiPropertyOptional({
    description: 'Requested corrected break start timestamp in ISO 8601 UTC format.',
    example: '2026-11-04T07:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601({}, { message: 'requestedBreakStartedAt must be a valid ISO 8601 UTC timestamp.' })
  requestedBreakStartedAt?: string;

  @ApiPropertyOptional({
    description: 'Requested corrected break end timestamp in ISO 8601 UTC format.',
    example: '2026-11-04T07:30:00.000Z',
  })
  @IsOptional()
  @IsISO8601({}, { message: 'requestedBreakEndedAt must be a valid ISO 8601 UTC timestamp.' })
  requestedBreakEndedAt?: string;

  @ApiProperty({
    description: 'Detailed reason for attendance discrepancy and requested correction.',
    example: 'System connectivity outage prevented electronic checkout at 18:00 IST.',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(5, { message: 'Reason must be at least 5 characters long.' })
  @MaxLength(500, { message: 'Reason cannot exceed 500 characters.' })
  reason: string;

  @ApiPropertyOptional({
    description: 'Supporting evidence metadata (e.g. task IDs, Git commits, access card logs, reference URLs).',
    example: { evidenceReference: 'JIRA-10492; Git:commit-abc1234', notes: 'Verified with security desk card sweep.' },
  })
  @IsOptional()
  @IsObject()
  evidenceMetadata?: Record<string, any>;
}

