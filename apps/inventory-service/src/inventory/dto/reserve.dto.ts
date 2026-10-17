import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReserveLineDto {
  @IsUUID()
  orderLineId!: string;

  @IsUUID()
  productId!: string;

  @IsString()
  @Matches(/^\d{1,15}(\.\d{1,3})?$/)
  quantity!: string;
}

export class ReserveDto {
  @IsUUID()
  orderId!: string;

  @IsInt()
  @Min(1)
  orderVersion!: number;

  @IsUUID()
  warehouseId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReserveLineDto)
  lines!: ReserveLineDto[];
}
