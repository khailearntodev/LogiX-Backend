import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class DisableRecordDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Lý do không được để trống nếu đã cung cấp' })
  @MaxLength(500)
  reason?: string;
}
