import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CheckInDto {
  @ApiPropertyOptional({
    description: 'Optional physical location or geofence tag of check-in',
    example: 'Headquarters - Floor 3',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @ApiPropertyOptional({
    description: 'Client device information or user agent summary',
    example: 'Chrome 120 / Windows 11',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceInfo?: string;

  @ApiPropertyOptional({
    description: 'Optional employee remarks for the check-in',
    example: 'Starting morning session',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

