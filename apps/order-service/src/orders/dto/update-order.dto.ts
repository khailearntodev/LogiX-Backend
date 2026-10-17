import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ORDER_CURRENCY_PATTERN } from '../domain/order-constants.js';
import { OrderLineInputDto } from './create-order.dto.js';

export class UpdateOrderDto {
  @IsInt({ message: 'version phải là số nguyên' })
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;

  @IsOptional()
  @IsUUID('4', { message: 'customerId phải là UUID hợp lệ' })
  customerId?: string;

  @IsOptional()
  @IsUUID('4', { message: 'deliveryAddressId phải là UUID hợp lệ' })
  deliveryAddressId?: string;

  @IsOptional()
  @IsUUID('4', { message: 'warehouseId phải là UUID hợp lệ' })
  warehouseId?: string;

  @IsOptional()
  @IsString()
  @Matches(ORDER_CURRENCY_PATTERN, {
    message: 'currency phải là mã ISO 4217 gồm 3 chữ in hoa',
  })
  currency?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Đơn hàng phải có ít nhất 1 dòng' })
  @ValidateNested({ each: true })
  @Type(() => OrderLineInputDto)
  lines?: OrderLineInputDto[];
}
