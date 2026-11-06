import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class StopTaskTimerDto {
  @ApiPropertyOptional({
    description: 'Optional final comment on work session completion',
    example: 'Completed unit testing for the auth module',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  finalComment?: string;
}

