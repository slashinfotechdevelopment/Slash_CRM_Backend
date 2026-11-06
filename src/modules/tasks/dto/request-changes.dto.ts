import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RequestChangesDto {
  @ApiProperty({
    description: 'Detailed explanation of required changes or corrections',
    example: 'Please add validation for negative hours and update unit tests.',
    maxLength: 2000,
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(2000)
  feedback: string;
}

