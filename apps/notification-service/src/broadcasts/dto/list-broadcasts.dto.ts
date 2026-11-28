import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  DEFAULT_BROADCAST_PAGE_SIZE,
  MAX_BROADCAST_PAGE_SIZE,
} from '../../notifications/notification.constants.js';

function queryInteger(value: unknown): unknown {
  return typeof value === 'string' && /^\d+$/.test(value)
    ? Number(value)
    : value;
}

export class ListBroadcastsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => queryInteger(value))
  @IsInt()
  @Min(1)
  @Max(MAX_BROADCAST_PAGE_SIZE)
  limit: number = DEFAULT_BROADCAST_PAGE_SIZE;
}
