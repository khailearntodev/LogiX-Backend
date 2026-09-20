import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateOrganizationDto {
  @IsString()
  @IsOptional()
  @MinLength(2, { message: 'Tên tổ chức phải có ít nhất 2 ký tự' })
  name?: string;

  @IsString()
  @IsOptional()
  logoUrl?: string;
}
