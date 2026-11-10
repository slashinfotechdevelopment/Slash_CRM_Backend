import { IsOptional, IsString, IsBoolean } from 'class-validator';

export class AssignLeadDto {
  @IsOptional()
  @IsString()
  assignedToId?: string | null;

  @IsOptional()
  @IsString()
  departmentId?: string | null;

  @IsOptional()
  @IsBoolean()
  unassign?: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}

