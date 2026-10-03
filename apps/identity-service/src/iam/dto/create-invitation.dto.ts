import { ArrayMinSize, ArrayUnique, IsEmail, IsNotEmpty, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateInvitationDto {
  @IsEmail({}, { message: 'Email người nhận không đúng định dạng' })
  @IsNotEmpty({ message: 'Vui lòng nhập email người nhận' })
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  email!: string;

  @ArrayMinSize(1, { message: 'Vui lòng chọn ít nhất 1 vai trò cho người được mời' })
  @ArrayUnique({ message: 'Danh sách vai trò không được chứa ID trùng lặp' })
  @IsUUID('all', { each: true, message: 'ID vai trò không đúng định dạng UUID' })
  roleIds!: string[];
}
