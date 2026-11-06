import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RejectTaskReviewDto {
  @ApiProperty({
    description: 'Detailed reason for review rejection',
    example: 'Deliverable fails fundamental functional requirements.',
    maxLength: 2000,
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(2000)
  feedback: string;

  @ApiPropertyOptional({
    description: 'Whether to return the task to REOPENED for rework (default true) or leave as is',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  reopenTask?: boolean;
}

