import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import {
  AdminContactLeadStatus,
  CONTACT_LEAD_MAX_EMAIL_MESSAGE_LENGTH,
  CONTACT_LEAD_MAX_EMAIL_SUBJECT_LENGTH,
} from '../admin.constants.js';

export class UpdateContactLeadStatusDto {
  @IsEnum(AdminContactLeadStatus, {
    message: 'Trạng thái xử lý không hợp lệ',
  })
  status!: AdminContactLeadStatus;
}

export class SendContactLeadEmailDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'Tiêu đề email phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Vui lòng nhập tiêu đề email' })
  @MaxLength(CONTACT_LEAD_MAX_EMAIL_SUBJECT_LENGTH, {
    message: `Tiêu đề email không được vượt quá ${CONTACT_LEAD_MAX_EMAIL_SUBJECT_LENGTH} ký tự`,
  })
  subject!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'Nội dung email phải là chuỗi ký tự' })
  @IsNotEmpty({ message: 'Vui lòng nhập nội dung email' })
  @MaxLength(CONTACT_LEAD_MAX_EMAIL_MESSAGE_LENGTH, {
    message: `Nội dung email không được vượt quá ${CONTACT_LEAD_MAX_EMAIL_MESSAGE_LENGTH} ký tự`,
  })
  message!: string;
}

