import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTaskCommentDto {
  @ApiProperty({
    description: 'Comment content',
    example: 'Deployed new build to staging environment for testing.',
    maxLength: 5000,
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(5000)
  content: string;

  @ApiPropertyOptional({
    description: 'Optional parent comment ID for threaded replies',
    example: 'clx01comment001',
  })
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiPropertyOptional({
    description: 'Whether this comment is internal-only (invisible to client accounts)',
    example: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}

