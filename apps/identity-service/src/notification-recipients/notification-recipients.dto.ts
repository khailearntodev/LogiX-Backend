import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class ResolveNotificationRecipientsDto {
  @IsIn(['PERMISSION', 'USERS'])
  kind!: 'PERMISSION' | 'USERS';

  @ValidateIf((dto: ResolveNotificationRecipientsDto) => dto.kind === 'PERMISSION')
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code?: string;

  @ValidateIf((dto: ResolveNotificationRecipientsDto) => dto.kind === 'USERS')
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  userIds?: string[];
}
