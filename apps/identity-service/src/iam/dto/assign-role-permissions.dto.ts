import { ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class AssignRolePermissionsDto {
  @IsArray({ message: 'permissionIds phải là một mảng' })
  @IsUUID('all', { each: true, message: 'Mỗi permissionId phải là UUID hợp lệ' })
  @ArrayUnique({ message: 'Danh sách permissionIds không được trùng lặp' })
  permissionIds!: string[];
}
