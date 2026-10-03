import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/** Signed Decimal(18,3) as string; zero is rejected by the quantity_delta check constraint. */
const SIGNED_QUANTITY = /^-?\d{1,15}(\.\d{1,3})?$/;

export class AdjustStockDto {
  @IsString()
  @Matches(SIGNED_QUANTITY, {
    message: 'quantityDelta phải là số có dấu dạng chuỗi, tối đa 3 chữ số thập phân',
  })
  quantityDelta!: string;

  @IsString()
  @IsNotEmpty({ message: 'Điều chỉnh tồn kho bắt buộc phải có lý do' })
  @MaxLength(500)
  reason!: string;

  @IsString()
  @IsNotEmpty({ message: 'idempotencyKey không được để trống' })
  @MaxLength(100)
  idempotencyKey!: string;
}
