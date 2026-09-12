import { IsBoolean, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateOrganizationDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên tổ chức không được để trống' })
  @MinLength(2, { message: 'Tên tổ chức phải có ít nhất 2 ký tự' })
  name!: string;

  @IsString()
  @IsOptional()
  code?: string;

  @IsBoolean()
  @IsOptional()
  setAsDefault?: boolean;
}
