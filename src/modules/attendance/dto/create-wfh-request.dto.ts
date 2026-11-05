import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateWfhRequestDto {
  @ApiProperty({
    description: 'Work-from-home start date in YYYY-MM-DD format (Asia/Kolkata).',
    example: '2026-11-10',
  })
  @IsNotEmpty()
  @IsDateString()
  startDate: string;

  @ApiProperty({
    description: 'Work-from-home end date in YYYY-MM-DD format (Asia/Kolkata).',
    example: '2026-11-12',
  })
  @IsNotEmpty()
  @IsDateString()
  endDate: string;

  @ApiProperty({
    description: 'Business reason for working remotely.',
    example: 'Relocating temporarily / remote client support work.',
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  reason: string;
}

