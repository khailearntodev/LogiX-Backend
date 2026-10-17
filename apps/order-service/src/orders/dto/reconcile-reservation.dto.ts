import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type { ReserveRequest } from '@logix/messaging';
import { ORDER_QUANTITY_PATTERN } from '../domain/order-constants.js';

class ReconcileLineDto {
  @IsUUID()
  orderLineId!: string;

  @IsUUID()
  productId!: string;

  @IsString()
  @Matches(ORDER_QUANTITY_PATTERN)
  quantity!: string;
}

export class ReconcileReservationDto implements ReserveRequest {
  @IsUUID()
  reservationGroupId!: string;

  @IsUUID()
  orderId!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  orderVersion!: number;

  @IsUUID()
  warehouseId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReconcileLineDto)
  lines!: ReconcileLineDto[];
}
