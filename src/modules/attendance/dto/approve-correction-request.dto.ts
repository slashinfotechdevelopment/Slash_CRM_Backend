import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { VerificationOutcome } from '../../../generated/prisma/enums';

export class ApproveCorrectionRequestDto {
  @ApiPropertyOptional({
    description: 'Manager review notes or justification for approval.',
    example: 'Verified with security access logs and Jira tickets.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'managerNotes cannot exceed 500 characters.' })
  managerNotes?: string;

  @ApiPropertyOptional({
    description: 'Independent evidence reference or identifier verified by reviewer (e.g. CCTV log #, ticket ID).',
    example: 'CCTV-CAM02-20261104-0900',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'evidenceReference cannot exceed 500 characters.' })
  evidenceReference?: string;

  @ApiPropertyOptional({
    description: 'Outcome of evidence verification.',
    enum: VerificationOutcome,
    default: VerificationOutcome.VERIFIED,
  })
  @IsOptional()
  @IsEnum(VerificationOutcome)
  evidenceOutcome?: VerificationOutcome = VerificationOutcome.VERIFIED;

  @ApiPropertyOptional({
    description: 'Detailed auditor notes for evidence verification.',
    example: 'Access card scan at turnstile B matches requested 18:05 checkout.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'verificationNotes cannot exceed 1000 characters.' })
  verificationNotes?: string;
}

