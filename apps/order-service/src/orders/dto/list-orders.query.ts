import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ORDER_MAX_PAGE_SIZE,
  ORDER_NUMBER_SEARCH_MAX_LENGTH,
} from '../domain/order-constants.js';
import { ORDER_STATUSES, type OrderStatus } from '../domain/order-status.js';

/** Accepts both `?status=A&status=B` and `?status=A,B`. */
const toStatusArray = ({ value }: { value: unknown }): unknown => {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  return raw.flatMap((item) =>
    typeof item === 'string'
      ? item
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : [item],
  );
};

export class ListOrdersQueryDto {
  /** Order number search (prefix/contains, case-insensitive). */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(ORDER_NUMBER_SEARCH_MAX_LENGTH)
  q?: string;

  @IsOptional()
  @IsUUID('4', { message: 'customerId phải là UUID hợp lệ' })
  customerId?: string;

  @IsOptional()
  @IsUUID('4', { message: 'warehouseId phải là UUID hợp lệ' })
  warehouseId?: string;

  @IsOptional()
  @Transform(toStatusArray)
  @IsArray()
  @IsIn(ORDER_STATUSES, { each: true, message: 'status không hợp lệ' })
  status?: OrderStatus[];

  @IsOptional()
  @IsISO8601(
    { strict: true },
    { message: 'createdFrom phải là thời điểm ISO 8601' },
  )
  createdFrom?: string;

  @IsOptional()
  @IsISO8601(
    { strict: true },
    { message: 'createdTo phải là thời điểm ISO 8601' },
  )
  createdTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ORDER_MAX_PAGE_SIZE)
  pageSize?: number;
}
