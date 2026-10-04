import {
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateWarehouseDto {
  @IsString()
  @IsNotEmpty({ message: 'Mã kho không được để trống' })
  @MaxLength(50)
  code!: string;

  @IsString()
  @IsNotEmpty({ message: 'Tên kho không được để trống' })
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsNotEmpty({ message: 'Địa chỉ kho không được để trống' })
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

  /** String, like every other Decimal column, so 6-digit precision is never a float. */
  @IsOptional()
  @IsString()
  @IsLatitude({ message: 'latitude phải nằm trong khoảng -90 đến 90' })
  latitude?: string;

  @IsOptional()
  @IsString()
  @IsLongitude({ message: 'longitude phải nằm trong khoảng -180 đến 180' })
  longitude?: string;
}
