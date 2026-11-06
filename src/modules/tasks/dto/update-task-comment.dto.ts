import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateTaskCommentDto {
  @ApiProperty({
    description: 'Updated comment content',
    example: 'Updated comment: staging build verified and signed off.',
    maxLength: 5000,
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(5000)
  content: string;
}

