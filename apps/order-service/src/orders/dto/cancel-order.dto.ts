import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ORDER_CANCEL_REASON_MAX_LENGTH } from '../domain/order-constants.js';

export class CancelOrderDto {
  @IsInt({ message: 'version phải là số nguyên' })
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Hủy đơn hàng bắt buộc phải có lý do' })
  @MaxLength(ORDER_CANCEL_REASON_MAX_LENGTH)
  reason!: string;
}
