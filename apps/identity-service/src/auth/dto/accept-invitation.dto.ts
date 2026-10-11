import { IsOptional, IsString, Length, MinLength } from 'class-validator';

export class AcceptInvitationDto {
  @IsString({ message: 'Mật khẩu phải là chuỗi ký tự' })
  @MinLength(8, { message: 'Mật khẩu phải có ít nhất 8 ký tự' })
  @IsOptional()
  password?: string;

  @IsString({ message: 'Tên hiển thị phải là chuỗi ký tự' })
  @Length(2, 100, { message: 'Tên hiển thị phải từ 2 đến 100 ký tự' })
  @IsOptional()
  displayName?: string;
}
