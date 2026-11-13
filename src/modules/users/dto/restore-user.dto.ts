import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class RestoreUserDto {
  @ApiPropertyOptional({
    description:
      'User ID (CUID), Employee Code (userCode, e.g. EMP049), or Email (e.g. employee@company.com)',
    example: 'EMP049',
  })
  @IsOptional()
  @IsString()
  identifier?: string;

  @ApiPropertyOptional({
    description: 'Employee code alias for identifier (e.g. EMP049)',
    example: 'EMP049',
  })
  @IsOptional()
  @IsString()
  userCode?: string;

  @ApiPropertyOptional({
    description: 'Email alias for identifier (e.g. employee@company.com)',
    example: 'employee@company.com',
  })
  @IsOptional()
  @IsString()
  email?: string;
}

