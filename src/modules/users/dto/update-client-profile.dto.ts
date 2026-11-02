import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateClientProfileDto {
  @ApiPropertyOptional({
    description: 'Registered company or organization name',
    example: 'ABC Technologies Private Limited',
  })
  @IsOptional()
  @IsString({ message: 'companyName must be a string.' })
  @MinLength(2, { message: 'companyName must be at least 2 characters long.' })
  @MaxLength(180, { message: 'companyName cannot exceed 180 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  companyName?: string;

  @ApiPropertyOptional({
    description: 'Company official website URL',
    example: 'https://newdomain.com',
  })
  @IsOptional()
  @IsUrl({}, { message: 'website must be a valid URL (e.g. https://example.com).' })
  @MaxLength(191, { message: 'website cannot exceed 191 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  website?: string;

  @ApiPropertyOptional({
    description: 'Tax identifier (e.g. GSTIN, PAN, or alphanumeric tax registration number)',
    example: '33AAAAA0000A1Z5',
  })
  @IsOptional()
  @IsString({ message: 'taxNumber must be a string.' })
  @Matches(/^[A-Za-z0-9\-\/]{3,40}$/, {
    message:
      'taxNumber must be a valid alphanumeric tax identifier between 3 and 40 characters.',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  taxNumber?: string;

  @ApiPropertyOptional({
    description: 'Address line 1',
    example: '456 Business Square',
  })
  @IsOptional()
  @IsString({ message: 'addressLine1 must be a string.' })
  @MaxLength(255, { message: 'addressLine1 cannot exceed 255 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  addressLine1?: string;

  @ApiPropertyOptional({
    description: 'Address line 2',
    example: 'Tower B, 5th Floor',
  })
  @IsOptional()
  @IsString({ message: 'addressLine2 must be a string.' })
  @MaxLength(255, { message: 'addressLine2 cannot exceed 255 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  addressLine2?: string;

  @ApiPropertyOptional({
    description: 'City',
    example: 'Chennai',
  })
  @IsOptional()
  @IsString({ message: 'city must be a string.' })
  @MaxLength(100, { message: 'city cannot exceed 100 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  city?: string;

  @ApiPropertyOptional({
    description: 'State / Province',
    example: 'Tamil Nadu',
  })
  @IsOptional()
  @IsString({ message: 'state must be a string.' })
  @MaxLength(100, { message: 'state cannot exceed 100 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  state?: string;

  @ApiPropertyOptional({
    description: 'Postal / ZIP code',
    example: '600001',
  })
  @IsOptional()
  @IsString({ message: 'postalCode must be a string.' })
  @Matches(/^[A-Za-z0-9\s\-]{3,20}$/, {
    message: 'postalCode must be between 3 and 20 alphanumeric characters.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  postalCode?: string;

  @ApiPropertyOptional({
    description: 'Country',
    example: 'India',
  })
  @IsOptional()
  @IsString({ message: 'country must be a string.' })
  @MaxLength(100, { message: 'country cannot exceed 100 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  country?: string;

  @ApiPropertyOptional({
    description: 'Client company logo media ID',
    example: 'cmvw7w8a90001w0twfj2logo1',
  })
  @IsOptional()
  @IsString({ message: 'logoMediaId must be a string.' })
  @MaxLength(30, { message: 'logoMediaId cannot exceed 30 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  logoMediaId?: string;
}

