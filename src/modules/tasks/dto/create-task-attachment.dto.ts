import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTaskAttachmentDto {
  @ApiPropertyOptional({
    description: 'Original file name (required when providing JSON metadata without binary upload)',
    example: 'requirements_spec_v2.pdf',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  originalName?: string;

  @ApiPropertyOptional({
    description: 'MIME type of the attachment (required when providing JSON metadata without binary upload)',
    example: 'application/pdf',
    maxLength: 150,
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  mimeType?: string;

  @ApiPropertyOptional({
    description: 'File size in bytes (maximum 25MB = 26,214,400 bytes)',
    example: 1048576,
    minimum: 1,
    maximum: 26214400,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(26214400)
  fileSizeBytes?: number;

  @ApiPropertyOptional({
    description: 'Safe external or secure CDN URL for the file (local filesystem paths will be rejected)',
    example: 'https://storage.slashcrm.internal/tasks/clx01deliverable.pdf',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  fileUrl?: string;

  @ApiPropertyOptional({
    description: 'Attachment collection or category (e.g. attachments, submission, review)',
    example: 'submission',
    default: 'attachments',
    maxLength: 80,
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  collection?: string;
}

