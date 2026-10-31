import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const DRIVER_USER_PAGE_SIZE = 20;
export const DRIVER_USER_MAX_PAGE_SIZE = 100;

export class DriverUsersQuery {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DRIVER_USER_MAX_PAGE_SIZE)
  pageSize?: number;
}

export class ResolveDriverUsersDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(DRIVER_USER_MAX_PAGE_SIZE)
  @IsUUID('all', { each: true })
  userIds!: string[];
}
