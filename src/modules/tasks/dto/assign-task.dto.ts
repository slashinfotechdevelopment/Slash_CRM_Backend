import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AssignTaskDto {
  @ApiProperty({
    description: 'Target user ID to assign or reassign the task to. Set null or omit if unassigning.',
    example: 'clx01employee000999',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  assigneeId?: string | null;

  @ApiPropertyOptional({
    description: 'Reason for task assignment or reassignment.',
    example: 'Reassigned due to workload balancing in Sprint 4.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

