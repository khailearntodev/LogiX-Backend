import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  CONTACT_LEAD_MAX_COMPANY_LENGTH,
  CONTACT_LEAD_MAX_EMAIL_LENGTH,
  CONTACT_LEAD_MAX_NAME_LENGTH,
  CONTACT_LEAD_MAX_NEEDS,
  CONTACT_LEAD_MAX_OTHER_DETAIL_LENGTH,
  CONTACT_LEAD_MAX_PHONE_LENGTH,
  CONTACT_LEAD_PHONE_PATTERN,
  ContactNeedCategory,
} from '../admin.constants.js';

export class CreateContactLeadDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'Họ và tên phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Vui lòng nhập họ và tên' })
  @MaxLength(CONTACT_LEAD_MAX_NAME_LENGTH, {
    message: `Họ và tên không được vượt quá ${CONTACT_LEAD_MAX_NAME_LENGTH} ký tự`,
  })
  fullName!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString({ message: 'Email phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Vui lòng nhập địa chỉ email' })
  @IsEmail({}, { message: 'Địa chỉ email không hợp lệ' })
  @MaxLength(CONTACT_LEAD_MAX_EMAIL_LENGTH, {
    message: `Email không được vượt quá ${CONTACT_LEAD_MAX_EMAIL_LENGTH} ký tự`,
  })
  email!: string;

  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  })
  @IsOptional()
  @IsString({ message: 'Số điện thoại phải là chuỗi ký tự' })
  @MaxLength(CONTACT_LEAD_MAX_PHONE_LENGTH, {
    message: `Số điện thoại không được vượt quá ${CONTACT_LEAD_MAX_PHONE_LENGTH} ký tự`,
  })
  @Matches(CONTACT_LEAD_PHONE_PATTERN, {
    message: 'Số điện thoại không đúng định dạng',
  })
  phoneNumber?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'Tên doanh nghiệp phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Vui lòng nhập tên doanh nghiệp' })
  @MaxLength(CONTACT_LEAD_MAX_COMPANY_LENGTH, {
    message: `Tên doanh nghiệp không được vượt quá ${CONTACT_LEAD_MAX_COMPANY_LENGTH} ký tự`,
  })
  companyName!: string;

  @IsArray({ message: 'Danh sách nhu cầu không hợp lệ' })
  @ArrayMinSize(1, { message: 'Vui lòng chọn ít nhất một nhu cầu hiện tại' })
  @ArrayMaxSize(CONTACT_LEAD_MAX_NEEDS, {
    message: `Chỉ được chọn tối đa ${CONTACT_LEAD_MAX_NEEDS} nhu cầu`,
  })
  @ArrayUnique({ message: 'Danh sách nhu cầu không được trùng lặp' })
  @IsEnum(ContactNeedCategory, {
    each: true,
    message: 'Nhu cầu được chọn không hợp lệ',
  })
  needs!: ContactNeedCategory[];

  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  })
  @ValidateIf((dto: CreateContactLeadDto) =>
    Array.isArray(dto.needs) && dto.needs.includes(ContactNeedCategory.OTHER),
  )
  @IsString({ message: 'Mô tả nhu cầu khác phải là chuỗi ký tự' })
  @IsNotEmpty({
    message: 'Vui lòng nhập mô tả chi tiết khi chọn nhu cầu Khác',
  })
  @MaxLength(CONTACT_LEAD_MAX_OTHER_DETAIL_LENGTH, {
    message: `Mô tả nhu cầu khác không được vượt quá ${CONTACT_LEAD_MAX_OTHER_DETAIL_LENGTH} ký tự`,
  })
  otherNeedDetail?: string;
}

