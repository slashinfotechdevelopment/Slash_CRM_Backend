import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectOvertimeRequestDto {
  @ApiPropertyOptional({
    description: 'Reason or manager remarks for rejecting the overtime request.',
    example: 'Budget limits exceeded for this sprint.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  managerNotes?: string;
}

