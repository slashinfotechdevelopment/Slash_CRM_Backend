import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LeaveApprovalDecision } from '../../../generated/prisma/enums';

export class ReviewLeaveRequestDto {
  @ApiProperty({
    description: 'Approval decision: APPROVED or REJECTED',
    enum: LeaveApprovalDecision,
    example: LeaveApprovalDecision.APPROVED,
  })
  @IsEnum(LeaveApprovalDecision)
  @IsNotEmpty()
  decision: LeaveApprovalDecision;

  @ApiPropertyOptional({
    description: 'Optional reviewer remarks or justification',
    example: 'Approved. Ensure tasks are handed over to peer.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comments?: string;
}

