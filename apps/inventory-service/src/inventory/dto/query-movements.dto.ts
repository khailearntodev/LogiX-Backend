import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { MAX_PAGE_SIZE, ReferenceType } from '../inventory.constants.js';

export class QueryMovementsDto {
  @IsOptional()
  @IsUUID('4', { message: 'warehouseId phải là UUID hợp lệ' })
  warehouseId?: string;

  @IsOptional()
  @IsUUID('4', { message: 'productId phải là UUID hợp lệ' })
  productId?: string;

  @IsOptional()
  @IsString()
  @IsIn(Object.values(ReferenceType))
  referenceType?: string;

  @IsOptional()
  @IsUUID('4', { message: 'referenceId phải là UUID hợp lệ' })
  referenceId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number;
}
