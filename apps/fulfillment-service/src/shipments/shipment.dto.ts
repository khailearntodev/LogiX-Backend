import { Type, Transform } from 'class-transformer';
import {
  Equals,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { SHIPMENT_STATUS } from '@logix/messaging';
import {
  MAX_PAGE_SIZE,
  MAX_PAGE_NUMBER,
  MAX_REASON_LENGTH,
} from './shipment.domain.js';

export class ShipmentVersionDto {
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) version!: number;
}
export class DispatchShipmentDto extends ShipmentVersionDto {
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) orderVersion!: number;
  @IsUUID() requestId!: string;
  @Equals(true) confirmed!: boolean;
}
export class CompleteShipmentDto extends ShipmentVersionDto {
  @Equals(true) confirmed!: boolean;
}
export class FailShipmentDto extends CompleteShipmentDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_REASON_LENGTH)
  reason!: string;
}
export class ShipmentQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_NUMBER)
  page?: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number;
  @IsOptional() @IsUUID() warehouseId?: string;
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsIn(Object.values(SHIPMENT_STATUS)) status?: string;
  @IsOptional() @IsISO8601({ strict: true }) createdFrom?: string;
  @IsOptional() @IsISO8601({ strict: true }) createdTo?: string;
}
