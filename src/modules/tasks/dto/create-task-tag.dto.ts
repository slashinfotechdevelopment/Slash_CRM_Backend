import { IsNotEmpty, IsOptional, IsString, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTaskTagDto {
  @ApiProperty({
    description: 'Unique tag name.',
    example: 'backend',
    maxLength: 50,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string;

  @ApiPropertyOptional({
    description: 'Hex color code or CSS color string for tag UI badge.',
    example: '#3B82F6',
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;
}

