import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class RecalculateAttendanceDto {
  @ApiPropertyOptional({
    description:
      'Whether the attendance date has passed its end-of-day reconciliation cutoff.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isReconciled?: boolean;
}

