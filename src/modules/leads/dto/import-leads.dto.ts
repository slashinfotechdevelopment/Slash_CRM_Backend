import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ImportLeadRowDto {
  @IsOptional()
  @IsString()
  date?: string;

  @IsString()
  @IsNotEmpty({ message: 'Name is required for import row.' })
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'Contact/phone is required for import row.' })
  contact: string;

  @IsOptional()
  @IsString()
  course?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  feedback1?: string;

  @IsOptional()
  @IsString()
  feedback2?: string;

  @IsOptional()
  @IsString()
  feedback3?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsString()
  sourceDetails?: string;

  @IsOptional()
  @IsString()
  campaignName?: string;
}

export class ImportLeadsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportLeadRowDto)
  rows: ImportLeadRowDto[];

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean = false;
}

