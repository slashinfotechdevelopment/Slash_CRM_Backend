import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LeaveCancellationStatus } from '../../../generated/prisma/enums';

export class ReviewCancellationRequestDto {
  @ApiProperty({
    description: 'Decision on cancellation request: APPROVED or REJECTED',
    enum: LeaveCancellationStatus,
    example: LeaveCancellationStatus.APPROVED,
  })
  @IsEnum(LeaveCancellationStatus)
  @IsNotEmpty()
  decision: LeaveCancellationStatus;

  @ApiPropertyOptional({
    description: 'Reviewer notes or reason for approval/rejection',
    example: 'Cancellation approved. Balance restored and attendance unblocked.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewerNotes?: string;
}

