import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

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

  @ApiPropertyOptional({
    description: 'Alias for approvedDurationMinutes matching frontend approval modal.',
    example: 120,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  approvedMinutes?: number;

  @ApiPropertyOptional({
    description: 'Optional manager remarks or approval comments.',
    example: 'Approved for urgent client release.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  managerNotes?: string;

  @ApiPropertyOptional({
    description: 'Alias for managerNotes.',
    example: 'Approved for urgent client release.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    description: 'Alias for managerNotes.',
    example: 'Approved for urgent client release.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

