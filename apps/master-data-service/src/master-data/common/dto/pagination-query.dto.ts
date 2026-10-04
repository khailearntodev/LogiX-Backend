import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_PAGE_SIZE, RecordStatus } from '../master-data.constants.js';

export class PaginationQueryDto {
  /** Free-text filter; each resource decides which columns it searches. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(Object.values(RecordStatus), {
    message: 'status phải là ACTIVE hoặc INACTIVE',
  })
  status?: RecordStatus;

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
