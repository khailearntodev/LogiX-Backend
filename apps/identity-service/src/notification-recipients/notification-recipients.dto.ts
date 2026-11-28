import 'reflect-metadata';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export const MAX_RECIPIENT_RESOLVE_LIMIT = 500;
export const DEFAULT_RECIPIENT_RESOLVE_LIMIT = 500;

export class RecipientAudienceDto {
  @IsIn(['ALL', 'ROLES', 'USERS', 'PERMISSION'])
  kind!: 'ALL' | 'ROLES' | 'USERS' | 'PERMISSION';

  @ValidateIf((dto: RecipientAudienceDto) => dto.kind === 'PERMISSION')
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code?: string;

  @ValidateIf((dto: RecipientAudienceDto) => dto.kind === 'USERS')
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  userIds?: string[];

  @ValidateIf((dto: RecipientAudienceDto) => dto.kind === 'ROLES')
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  roleIds?: string[];
}

export class ResolveNotificationRecipientsDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => RecipientAudienceDto)
  audience!: RecipientAudienceDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_RECIPIENT_RESOLVE_LIMIT)
  limit?: number;

  @IsOptional()
  @IsUUID()
  cursor?: string | null;

  @IsOptional()
  @IsISO8601()
  snapshotAt?: string | null;
}
