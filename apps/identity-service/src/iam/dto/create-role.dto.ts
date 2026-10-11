import { IsArray, IsNotEmpty, IsOptional, IsString, Length, Matches, ArrayUnique, IsUUID } from 'class-validator';

export class CreateRoleDto {
  @IsString({ message: 'Tên vai trò phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Vui lòng nhập tên vai trò' })
  @Length(2, 100, { message: 'Tên vai trò phải từ 2 đến 100 ký tự' })
  name!: string;

  @IsString({ message: 'Mã vai trò phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Vui lòng nhập mã vai trò' })
  @Length(2, 50, { message: 'Mã vai trò phải từ 2 đến 50 ký tự' })
  @Matches(/^[A-Z0-9_]+$/, {
    message: 'Mã vai trò chỉ được chứa chữ hoa, số và dấu gạch dưới (VD: DISPATCHER, STOCK_KEEPER)',
  })
  code!: string;

  @IsString({ message: 'Mô tả phải là chuỗi ký tự' })
  @IsOptional()
  description?: string;

  @IsArray({ message: 'Danh sách quyền phải là một mảng' })
  @IsUUID('all', { each: true, message: 'ID quyền hạn không đúng định dạng UUID' })
  @ArrayUnique({ message: 'Danh sách quyền không được chứa ID trùng lặp' })
  @IsOptional()
  permissionIds?: string[];
}
