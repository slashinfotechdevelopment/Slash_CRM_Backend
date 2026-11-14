import {
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCancellationRequestDto {
  @ApiProperty({
    description: 'Reason for requesting cancellation of approved leave',
    example: 'Event postponed; will be available to report to office.',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

