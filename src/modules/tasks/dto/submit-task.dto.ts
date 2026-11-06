import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitTaskDto {
  @ApiPropertyOptional({
    description: 'Submission notes or summary of work delivered',
    example: 'Completed all API endpoints and integration tests for module X.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    description: 'Optional array of media attachment IDs related to the submission',
    example: ['clx01media001'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachmentIds?: string[];
}

