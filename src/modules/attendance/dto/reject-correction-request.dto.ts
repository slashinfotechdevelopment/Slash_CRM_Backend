import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { VerificationOutcome } from '../../../generated/prisma/enums';

export class RejectCorrectionRequestDto {
  @ApiPropertyOptional({
    description: 'Reason for rejecting the correction request.',
    example: 'Submitted evidence does not substantiate physical presence after 17:00.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'managerNotes cannot exceed 500 characters.' })
  managerNotes?: string;

  @ApiPropertyOptional({
    description: 'Alias for managerNotes matching frontend rejection modal.',
    example: 'Submitted evidence does not substantiate physical presence after 17:00.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'rejectionReason cannot exceed 500 characters.' })
  rejectionReason?: string;

  @ApiPropertyOptional({
    description: 'Alias for managerNotes.',
    example: 'Submitted evidence does not substantiate physical presence after 17:00.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'reason cannot exceed 500 characters.' })
  reason?: string;

  @ApiPropertyOptional({
    description: 'Alias for managerNotes.',
    example: 'Submitted evidence does not substantiate physical presence after 17:00.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'remarks cannot exceed 500 characters.' })
  remarks?: string;

  @ApiPropertyOptional({
    description: 'Alias for managerNotes.',
    example: 'Submitted evidence does not substantiate physical presence after 17:00.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'notes cannot exceed 500 characters.' })
  notes?: string;

  @ApiPropertyOptional({
    description: 'Outcome of evidence verification.',
    enum: VerificationOutcome,
    default: VerificationOutcome.REJECTED,
  })
  @IsOptional()
  @IsEnum(VerificationOutcome)
  evidenceOutcome?: VerificationOutcome = VerificationOutcome.REJECTED;

  @ApiPropertyOptional({
    description: 'Detailed auditor notes for evidence verification.',
    example: 'No turnstile access swipe found for employee during requested interval.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'verificationNotes cannot exceed 1000 characters.' })
  verificationNotes?: string;
}
