import { IsUUID } from 'class-validator';

export class ReleaseDto {
  @IsUUID()
  orderId!: string;
}
