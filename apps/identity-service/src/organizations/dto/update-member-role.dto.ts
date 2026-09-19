import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class UpdateMemberRoleDto {
  @IsString()
  @IsNotEmpty({ message: 'Vai trò không được để trống' })
  @IsIn(['OWNER', 'ADMIN', 'MEMBER'], {
    message: 'Vai trò phải là OWNER, ADMIN hoặc MEMBER',
  })
  role!: 'OWNER' | 'ADMIN' | 'MEMBER';
}
