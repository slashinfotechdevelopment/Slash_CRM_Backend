import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DeviceType } from '../../../generated/prisma/enums';

export class PlayTaskTimerDto {
  @ApiPropertyOptional({
    description: 'Device used to play timer (WEB, MOBILE, DESKTOP, SYSTEM)',
    enum: DeviceType,
    default: DeviceType.WEB,
  })
  @IsOptional()
  @IsEnum(DeviceType)
  deviceType?: DeviceType = DeviceType.WEB;

  @ApiPropertyOptional({
    description: 'Client IP address',
    example: '192.168.1.1',
  })
  @IsOptional()
  @IsString()
  @MaxLength(45)
  ipAddress?: string;

  @ApiPropertyOptional({
    description: 'Client User Agent string',
    example: 'Mozilla/5.0 ...',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  userAgent?: string;
}

