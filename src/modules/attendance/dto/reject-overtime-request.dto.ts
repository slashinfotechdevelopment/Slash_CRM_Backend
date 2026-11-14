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

  @ApiPropertyOptional({
    description: 'Alias for managerNotes matching frontend rejection modal.',
    example: 'Budget limits exceeded for this sprint.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  rejectionReason?: string;

  @ApiPropertyOptional({
    description: 'Alias for managerNotes.',
    example: 'Budget limits exceeded for this sprint.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    description: 'Alias for managerNotes.',
    example: 'Budget limits exceeded for this sprint.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;

  @ApiPropertyOptional({
    description: 'Alias for managerNotes.',
    example: 'Budget limits exceeded for this sprint.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
