import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  MAX_NOTIFICATION_PAGE_SIZE,
} from '../notification.constants.js';

function queryInteger(value: unknown): unknown {
  return typeof value === 'string' && /^\d+$/.test(value)
    ? Number(value)
    : value;
}

function queryBoolean(value: unknown): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export class ListNotificationsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => queryInteger(value))
  @IsInt()
  @Min(1)
  @Max(MAX_NOTIFICATION_PAGE_SIZE)
  limit: number = DEFAULT_NOTIFICATION_PAGE_SIZE;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => queryBoolean(value))
  @IsBoolean()
  unreadOnly: boolean = false;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => queryBoolean(value))
  @IsBoolean()
  includeArchived: boolean = false;
}
