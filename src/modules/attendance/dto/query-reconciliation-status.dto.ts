import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class QueryReconciliationStatusDto {
  @ApiProperty({
    description: 'Target employee ID to inspect reconciliation status.',
    example: 'usr_1234567890',
  })
  @IsNotEmpty()
  @IsString()
  userId: string;

  @ApiProperty({
    description: 'Target attendance date in YYYY-MM-DD format.',
    example: '2026-11-04',
  })
  @IsNotEmpty()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date must be formatted as YYYY-MM-DD',
  })
  date: string;
}

