import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum AnomalyResolutionAction {
  RESOLVE = 'RESOLVE',
  DISMISS = 'DISMISS',
}

export class ResolveAnomalyDto {
  @ApiProperty({
    description: 'Action to perform on the quarantined anomaly (RESOLVE or DISMISS).',
    enum: AnomalyResolutionAction,
  })
  @IsNotEmpty()
  @IsEnum(AnomalyResolutionAction)
  action: AnomalyResolutionAction;

  @ApiProperty({
    description: 'Mandatory explanation/justification for resolving or dismissing the anomaly.',
    minLength: 5,
    maxLength: 500,
    example: 'Verified manual sign-in sheet with supervisor approval.',
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(5, {
    message: 'Resolution notes must be at least 5 characters long.',
  })
  @MaxLength(500, {
    message: 'Resolution notes cannot exceed 500 characters.',
  })
  notes: string;

  @ApiPropertyOptional({
    description: 'Whether to trigger automatic attendance recalculation after resolving the anomaly.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  recalculate?: boolean = true;
}

