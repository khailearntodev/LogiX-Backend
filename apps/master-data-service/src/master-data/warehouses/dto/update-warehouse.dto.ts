import {
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

/** Every field is optional. */
export class UpdateWarehouseDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(50)
  code?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Tên kho không được để trống' })
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Địa chỉ kho không được để trống' })
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
