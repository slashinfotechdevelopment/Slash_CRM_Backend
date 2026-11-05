import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

export class ApproveOvertimeRequestDto {
  @ApiPropertyOptional({
    description:
      'Optionally specify authorized overtime duration in minutes (defaults to requested interval duration).',
    example: 120,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  approvedDurationMinutes?: number;
}

