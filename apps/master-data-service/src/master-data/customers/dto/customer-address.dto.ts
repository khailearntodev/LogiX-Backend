import {
  IsBoolean,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateCustomerAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsString()
  @IsNotEmpty({ message: 'Tên người nhận không được để trống' })
  @MaxLength(200)
  recipientName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsString()
  @IsNotEmpty({ message: 'Địa chỉ không được để trống' })
  addressLine!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ward?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  district?: string;

  @IsString()
  @IsNotEmpty({ message: 'Tỉnh/thành phố không được để trống' })
  @MaxLength(100)
  province!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @IsOptional()
  @IsString()
  @IsLatitude({ message: 'latitude phải nằm trong khoảng -90 đến 90' })
  latitude?: string;

  @IsOptional()
  @IsString()
  @IsLongitude({ message: 'longitude phải nằm trong khoảng -180 đến 180' })
  longitude?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateCustomerAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Tên người nhận không được để trống' })
  @MaxLength(200)
  recipientName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Địa chỉ không được để trống' })
  addressLine?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ward?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  district?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Tỉnh/thành phố không được để trống' })
  @MaxLength(100)
  province?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @IsOptional()
  @IsString()
  @IsLatitude({ message: 'latitude phải nằm trong khoảng -90 đến 90' })
  latitude?: string;

  @IsOptional()
  @IsString()
  @IsLongitude({ message: 'longitude phải nằm trong khoảng -180 đến 180' })
  longitude?: string;
}
