import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateCustomerDto {
  @IsString()
  @IsNotEmpty({ message: 'Mã khách hàng không được để trống' })
  @MaxLength(50)
  code!: string;

  @IsString()
  @IsNotEmpty({ message: 'Tên khách hàng không được để trống' })
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  taxCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Email không đúng định dạng' })
  @MaxLength(320)
  email?: string;
}

export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Tên khách hàng không được để trống' })
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  taxCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Email không đúng định dạng' })
  @MaxLength(320)
  email?: string;
}
