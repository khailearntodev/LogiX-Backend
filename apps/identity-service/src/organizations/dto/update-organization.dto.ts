import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MAX_TENANT_AI_INSTRUCTIONS_LENGTH } from '../domain/tenant-ai-instructions.policy.js';

/**
 * Legal-profile fields accept `null` or an empty string to clear the value.
 * `addressLine` and `province` must end up both set or both empty.
 */
export class UpdateOrganizationDto {
  @IsString()
  @IsOptional()
  @MinLength(2, { message: 'Tên tổ chức phải có ít nhất 2 ký tự' })
  name?: string;

  @IsString()
  @IsOptional()
  logoUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'Tên pháp lý tối đa 255 ký tự' })
  legalName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'Mã số thuế tối đa 50 ký tự' })
  taxCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30, { message: 'Số điện thoại tối đa 30 ký tự' })
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Địa chỉ tối đa 500 ký tự' })
  addressLine?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ward?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  district?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  province?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string | null;

  @IsOptional()
  @IsString({ message: 'Chỉ dẫn AI tùy chỉnh phải là chuỗi ký tự' })
  @MaxLength(MAX_TENANT_AI_INSTRUCTIONS_LENGTH, {
    message: `Chỉ dẫn AI tùy chỉnh không được vượt quá ${MAX_TENANT_AI_INSTRUCTIONS_LENGTH} ký tự`,
  })
  aiCustomInstructions?: string | null;

  @IsOptional()
  @IsBoolean({ message: 'Trạng thái kích hoạt chỉ dẫn AI phải là kiểu boolean' })
  aiInstructionsEnabled?: boolean;
}