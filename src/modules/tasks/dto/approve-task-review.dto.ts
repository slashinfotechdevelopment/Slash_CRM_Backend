import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ApproveTaskReviewDto {
  @ApiPropertyOptional({
    description: 'Reviewer approval feedback or comments',
    example: 'Work verified against requirements. Clean code and full test coverage.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  feedback?: string;

  @ApiPropertyOptional({
    description: 'Optional performance rating from 1 to 5',
    example: 5,
    minimum: 1,
    maximum: 5,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;
}

