import { IsOptional, IsString, Length } from 'class-validator';

export class UpdateRoleDto {
  @IsString({ message: 'Tên vai trò phải là chuỗi ký tự' })
  @Length(2, 100, { message: 'Tên vai trò phải từ 2 đến 100 ký tự' })
  @IsOptional()
  name?: string;

  @IsString({ message: 'Mô tả phải là chuỗi ký tự' })
  @IsOptional()
  description?: string;
}
