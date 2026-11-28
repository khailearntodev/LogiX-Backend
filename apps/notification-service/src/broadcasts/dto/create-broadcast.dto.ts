import 'reflect-metadata';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  MAX_BROADCAST_BODY_LENGTH,
  MAX_BROADCAST_LINK_LENGTH,
  MAX_BROADCAST_TITLE_LENGTH,
  NOTIFICATION_SEVERITIES,
  type NotificationSeverity,
} from '../../notifications/notification.constants.js';

export class BroadcastAudienceDto {
  @IsIn(['ALL', 'ROLES', 'USERS'])
  kind!: 'ALL' | 'ROLES' | 'USERS';

  @ValidateIf((dto: BroadcastAudienceDto) => dto.kind === 'ROLES')
  @IsArray()
  @IsUUID(undefined, { each: true })
  roleIds?: string[];

  @ValidateIf((dto: BroadcastAudienceDto) => dto.kind === 'USERS')
  @IsArray()
  @IsUUID(undefined, { each: true })
  userIds?: string[];
}

export class CreateBroadcastDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BROADCAST_TITLE_LENGTH)
  title!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BROADCAST_BODY_LENGTH)
  body!: string;

  @IsIn(Object.values(NOTIFICATION_SEVERITIES))
  severity!: NotificationSeverity;

  @IsDefined()
  @ValidateNested()
  @Type(() => BroadcastAudienceDto)
  audience!: BroadcastAudienceDto;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BROADCAST_LINK_LENGTH)
  @Matches(/^\/(?!\/)[^\s\\<>]*$/, {
    message: 'link must start with / and reject external or script URLs',
  })
  link?: string | null;
}
