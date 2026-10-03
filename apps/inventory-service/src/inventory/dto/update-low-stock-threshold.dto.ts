import { IsString, Matches } from 'class-validator';

const NON_NEGATIVE_QUANTITY = /^\d{1,15}(\.\d{1,3})?$/;

export class UpdateLowStockThresholdDto {
  @IsString()
  @Matches(NON_NEGATIVE_QUANTITY, {
    message: 'lowStockThreshold phải là số không âm dạng chuỗi, tối đa 3 chữ số thập phân',
  })
  lowStockThreshold!: string;
}
