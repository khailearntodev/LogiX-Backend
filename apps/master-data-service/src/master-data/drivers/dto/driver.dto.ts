import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { MAX_PAGE_SIZE } from '../../common/master-data.constants.js';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class EligibleDriverUsersQueryDto {
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
  @Max(MAX_PAGE_SIZE)
  pageSize?: number;
}

export class CreateDriverDto {
  @Transform(trimmed)
  @IsString()
  @Matches(/\S/)
  @MaxLength(50)
  code!: string;

  @IsUUID()
  userId!: string;

  @Transform(trimmed)
  @IsString()
  @Matches(/\S/)
  @MaxLength(100)
  licenseNumber!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  licenseExpiry!: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(30)
  phone?: string;
}

export class DriverVersionDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;
}

export class DriverLinkLockDto extends DriverVersionDto {
  @IsUUID()
  expectedUserId!: string;
}

export class RelinkDriverUserDto extends DriverLinkLockDto {
  @IsUUID()
  userId!: string;

  @Transform(trimmed)
  @IsString()
  @Matches(/\S/)
  @MaxLength(1000)
  reason!: string;
}

export class UpdateDriverDto extends DriverVersionDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(trimmed)
  @IsString()
  @Matches(/\S/)
  @MaxLength(100)
  licenseNumber?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  licenseExpiry?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(30)
  phone?: string | null;
}
