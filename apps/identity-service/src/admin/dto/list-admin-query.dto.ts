import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ADMIN_DEFAULT_PAGE,
  ADMIN_DEFAULT_PAGE_SIZE,
  ADMIN_MAX_PAGE_SIZE,
  ADMIN_MAX_SEARCH_LENGTH,
  AdminOrganizationStatus,
  AdminUserStatus,
} from '../admin.constants.js';

function queryInteger(value: unknown): unknown {
  return typeof value === 'string' && /^\d+$/.test(value)
    ? Number(value)
    : value;
}

export class ListAdminQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(ADMIN_MAX_SEARCH_LENGTH)
  q?: string;

  @Transform(({ value }: { value: unknown }) => queryInteger(value))
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  page: number = ADMIN_DEFAULT_PAGE;

  @Transform(({ value }: { value: unknown }) => queryInteger(value))
  @IsInt()
  @Min(1)
  @Max(ADMIN_MAX_PAGE_SIZE)
  pageSize: number = ADMIN_DEFAULT_PAGE_SIZE;
}

export class ListOrganizationsQueryDto extends ListAdminQueryDto {
  @IsOptional()
  @IsEnum(AdminOrganizationStatus)
  status?: AdminOrganizationStatus;
}

export class ListUsersQueryDto extends ListAdminQueryDto {
  @IsOptional()
  @IsEnum(AdminUserStatus)
  status?: AdminUserStatus;
}
