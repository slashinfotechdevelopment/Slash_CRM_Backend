import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { TaskPauseReason } from '../../../generated/prisma/enums';

export const MANUAL_TASK_PAUSE_REASONS = [
  TaskPauseReason.TEA_BREAK,
  TaskPauseReason.LUNCH,
  TaskPauseReason.PERSONAL_WORK,
  TaskPauseReason.MEETING,
  TaskPauseReason.WAITING,
  TaskPauseReason.TECHNICAL_ISSUE,
  TaskPauseReason.OTHER,
] as const;

export class PauseTaskTimerDto {
  @ApiProperty({
    description: 'Manual pause reason (system-generated reasons TASK_SWITCH, LOGOUT, and TASK_STATUS_CHANGE cannot be submitted)',
    enum: MANUAL_TASK_PAUSE_REASONS,
    example: TaskPauseReason.TEA_BREAK,
  })
  @IsNotEmpty()
  @IsEnum(TaskPauseReason)
  reason: TaskPauseReason;

  @ApiPropertyOptional({
    description: 'Custom description (Mandatory if reason is OTHER)',
    example: 'Doctor appointment',
  })
  @ValidateIf((o) => o.reason === TaskPauseReason.OTHER)
  @IsNotEmpty({ message: 'customDescription is required when pause reason is OTHER' })
  @IsString()
  @MaxLength(255)
  customDescription?: string;
}

