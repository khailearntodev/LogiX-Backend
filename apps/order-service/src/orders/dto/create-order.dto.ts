import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import {
  ORDER_CURRENCY_PATTERN,
  ORDER_QUANTITY_PATTERN,
} from '../domain/order-constants.js';

export class OrderLineInputDto {
  @IsUUID('4', { message: 'productId phải là UUID hợp lệ' })
  productId!: string;

  @IsString()
  @Matches(ORDER_QUANTITY_PATTERN, {
    message: 'quantity phải là số dương dạng chuỗi, tối đa 3 chữ số thập phân',
  })
  quantity!: string;
}

export class CreateOrderDto {
  @IsUUID('4', { message: 'customerId phải là UUID hợp lệ' })
  customerId!: string;

  @IsUUID('4', { message: 'deliveryAddressId phải là UUID hợp lệ' })
  deliveryAddressId!: string;

  @IsUUID('4', { message: 'warehouseId phải là UUID hợp lệ' })
  warehouseId!: string;

  @IsString()
  @Matches(ORDER_CURRENCY_PATTERN, {
    message: 'currency phải là mã ISO 4217 gồm 3 chữ in hoa',
  })
  currency!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Đơn hàng phải có ít nhất 1 dòng' })
  @ValidateNested({ each: true })
  @Type(() => OrderLineInputDto)
  lines!: OrderLineInputDto[];
}
