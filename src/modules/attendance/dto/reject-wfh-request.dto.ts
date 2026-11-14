import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectWfhRequestDto {
  @ApiPropertyOptional({
    description: 'Reason or supervisor remarks for rejecting the WFH request.',
    example: 'In-person team presence required for scheduled client workshop.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  managerNotes?: string;

  @ApiPropertyOptional({
    description: 'Alias for managerNotes matching frontend rejection modal.',
    example: 'In-person team presence required for scheduled client workshop.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  rejectionReason?: string;

  @ApiPropertyOptional({
    description: 'Alias for managerNotes.',
    example: 'In-person team presence required for scheduled client workshop.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    description: 'Alias for managerNotes.',
    example: 'In-person team presence required for scheduled client workshop.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;

  @ApiPropertyOptional({
    description: 'Alias for managerNotes.',
    example: 'In-person team presence required for scheduled client workshop.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
