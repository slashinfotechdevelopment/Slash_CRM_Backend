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
}

