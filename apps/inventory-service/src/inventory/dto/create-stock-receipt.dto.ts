import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Positive Decimal(18,3) as string — never a JS number. */
const POSITIVE_QUANTITY = /^\d{1,15}(\.\d{1,3})?$/;

export class StockReceiptLineDto {
  @IsUUID('4', { message: 'productId phải là UUID hợp lệ' })
  productId!: string;

  @IsString()
  @Matches(POSITIVE_QUANTITY, {
    message: 'quantity phải là số dương dạng chuỗi, tối đa 3 chữ số thập phân',
  })
  quantity!: string;
}

export class CreateStockReceiptDto {
  @IsUUID('4', { message: 'warehouseId phải là UUID hợp lệ' })
  warehouseId!: string;

  @IsString()
  @IsNotEmpty({ message: 'idempotencyKey không được để trống' })
  @MaxLength(100)
  idempotencyKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  receiptNumber?: string;

  @IsOptional()
  @IsDateString()
  receivedAt?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Phiếu nhập phải có ít nhất 1 dòng' })
  @ValidateNested({ each: true })
  @Type(() => StockReceiptLineDto)
  lines!: StockReceiptLineDto[];
}
