import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SyncGoogleHolidaysDto {
  @ApiProperty({
    description: 'Target calendar year to import government holidays for (e.g. 2026, 2027)',
    example: 2026,
  })
  @Type(() => Number)
  @IsNumber({}, { message: 'Target year must be a valid 4-digit number.' })
  @Min(2020, { message: 'Target year must be 2020 or later.' })
  @Max(2050, { message: 'Target year cannot exceed 2050.' })
  year: number;

  @ApiPropertyOptional({
    description: 'Country or region code (e.g. "IN" for India / Tamil Nadu / National Gazetted holidays)',
    default: 'IN',
  })
  @IsOptional()
  @IsString({ message: 'Region code must be a string (e.g. IN).' })
  region?: string;

  @ApiPropertyOptional({
    description: 'Whether to update existing holidays if matching dates already exist',
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'overwriteExisting must be a boolean.' })
  overwriteExisting?: boolean;
}
