import {
  IsNotEmpty,
  IsNumber,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AdjustLeaveBalanceDto {
  @ApiProperty({
    description: 'Target employee User ID',
    example: 'cmw123user456',
  })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({
    description: 'Leave Type ID to adjust',
    example: 'clw123leavetype456',
  })
  @IsString()
  @IsNotEmpty()
  leaveTypeId: string;

  @ApiProperty({
    description: 'Fiscal year of the balance record',
    example: 2026,
  })
  @IsNumber()
  @IsNotEmpty()
  year: number;

  @ApiProperty({
    description: 'Signed delta days to adjust (positive to credit, negative to debit)',
    example: 2.0,
  })
  @IsNumber()
  @IsNotEmpty()
  adjustedDays: number;

  @ApiProperty({
    description: 'Justification for manual HR balance adjustment',
    example: 'Compensatory off credit for Sunday deployment support.',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(255)
  reason: string;
}

