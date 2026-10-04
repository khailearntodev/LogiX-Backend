import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Decimal(18,3) as a string — a JS number would lose precision. */
const WEIGHT = /^\d{1,15}(\.\d{1,3})?$/;
/** Decimal(18,6) as a string. */
const VOLUME = /^\d{1,12}(\.\d{1,6})?$/;

export class CreateProductDto {
  @IsString()
  @IsNotEmpty({ message: 'SKU không được để trống' })
  @MaxLength(100)
  sku!: string;

  @IsString()
  @IsNotEmpty({ message: 'Tên sản phẩm không được để trống' })
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsNotEmpty({ message: 'Đơn vị cơ sở không được để trống' })
  @MaxLength(30)
  baseUnit!: string;

  @IsString()
  @Matches(WEIGHT, {
    message: 'weight phải là chuỗi số không âm, tối đa 3 chữ số thập phân',
  })
  weight!: string;

  @IsString()
  @Matches(VOLUME, {
    message: 'volume phải là chuỗi số không âm, tối đa 6 chữ số thập phân',
  })
  volume!: string;
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Tên sản phẩm không được để trống' })
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Đơn vị cơ sở không được để trống' })
  @MaxLength(30)
  baseUnit?: string;

  @IsOptional()
  @IsString()
  @Matches(WEIGHT, {
    message: 'weight phải là chuỗi số không âm, tối đa 3 chữ số thập phân',
  })
  weight?: string;

  @IsOptional()
  @IsString()
  @Matches(VOLUME, {
    message: 'volume phải là chuỗi số không âm, tối đa 6 chữ số thập phân',
  })
  volume?: string;
}
