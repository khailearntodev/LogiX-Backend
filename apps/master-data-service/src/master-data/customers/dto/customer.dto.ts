import {
  IsOptional,
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateCustomerDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(50)
  code?: string;

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
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(50)
  code?: string;

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
