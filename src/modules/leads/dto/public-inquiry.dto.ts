import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class PublicInquiryDto {
  @IsString()
  @IsNotEmpty({ message: 'Name is required.' })
  @MaxLength(150)
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'Phone number is required.' })
  @MaxLength(20)
  phone: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  course?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  location?: string;

  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  sourceDetails?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  campaignName?: string;
}

