import {
  IsOptional,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

/** Decimal(18,3), strictly positive per ck_vehicles_capacity_weight. */
const CAPACITY_WEIGHT = /^(?!0+(\.0{1,3})?$)\d{1,15}(\.\d{1,3})?$/;
/** Decimal(18,6), strictly positive per ck_vehicles_capacity_volume. */
const CAPACITY_VOLUME = /^(?!0+(\.0{1,6})?$)\d{1,12}(\.\d{1,6})?$/;

export class CreateVehicleDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(50)
  code?: string;

  @IsString()
  @IsNotEmpty({ message: 'Biển số không được để trống' })
  @MaxLength(30)
  licensePlate!: string;

  @IsString()
  @Matches(CAPACITY_WEIGHT, {
    message:
      'capacityWeight phải là chuỗi số lớn hơn 0, tối đa 3 chữ số thập phân',
  })
  capacityWeight!: string;

  @IsString()
  @Matches(CAPACITY_VOLUME, {
    message:
      'capacityVolume phải là chuỗi số lớn hơn 0, tối đa 6 chữ số thập phân',
  })
  capacityVolume!: string;
}

export class UpdateVehicleDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(50)
  code?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Biển số không được để trống' })
  @MaxLength(30)
  licensePlate?: string;

  @IsOptional()
  @IsString()
  @Matches(CAPACITY_WEIGHT, {
    message:
      'capacityWeight phải là chuỗi số lớn hơn 0, tối đa 3 chữ số thập phân',
  })
  capacityWeight?: string;

  @IsOptional()
  @IsString()
  @Matches(CAPACITY_VOLUME, {
    message:
      'capacityVolume phải là chuỗi số lớn hơn 0, tối đa 6 chữ số thập phân',
  })
  capacityVolume?: string;
}
