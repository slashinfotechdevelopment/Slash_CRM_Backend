import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CheckOutDto {
  @ApiPropertyOptional({
    description: 'Optional physical location or geofence tag of check-out',
    example: 'Headquarters - Floor 3',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @ApiPropertyOptional({
    description: 'Optional employee remarks for the check-out',
    example: 'Completed scheduled shift',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

