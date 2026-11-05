import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VerificationOutcome } from '../../../generated/prisma/enums';

export class RejectCorrectionRequestDto {
  @ApiProperty({
    description: 'Mandatory reason for rejecting the correction request.',
    example: 'Submitted evidence does not substantiate physical presence after 17:00.',
  })
  @IsString()
  @IsNotEmpty({ message: 'managerNotes is required when rejecting a correction request.' })
  @MinLength(5, { message: 'managerNotes must be at least 5 characters long.' })
  @MaxLength(500, { message: 'managerNotes cannot exceed 500 characters.' })
  managerNotes: string;

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

