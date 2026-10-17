import { IsInt, Max, Min } from 'class-validator';

export class ConfirmOrderDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;
}
