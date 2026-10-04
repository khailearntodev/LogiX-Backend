import { ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class AssignMemberRolesDto {
  @IsArray({ message: 'roleIds phải là một mảng' })
  @IsUUID('all', { each: true, message: 'Mỗi roleId phải là UUID hợp lệ' })
  @ArrayUnique({ message: 'Danh sách roleIds không được trùng lặp' })
  roleIds!: string[];
}
