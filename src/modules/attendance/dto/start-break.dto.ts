import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class StartBreakDto {
  @ApiProperty({
    description: 'Break type identifier (e.g. LUNCH, TEA, PERSONAL)',
    example: 'LUNCH',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  breakTypeId!: string;

  @ApiPropertyOptional({
    description: 'Optional employee remarks when taking the break',
    example: 'Going for team lunch',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

export class EndBreakDto {
  @ApiPropertyOptional({
    description: 'Optional employee remarks when concluding the break',
    example: 'Returned from break',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

