import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { MAX_TENANT_AI_INSTRUCTIONS_LENGTH } from '../domain/tenant-ai-instructions.policy.js';

export class UpdateTenantAiInstructionsDto {
  @IsOptional()
  @IsString({ message: 'Chỉ dẫn AI tùy chỉnh phải là chuỗi ký tự' })
  @MaxLength(MAX_TENANT_AI_INSTRUCTIONS_LENGTH, {
    message: `Chỉ dẫn AI tùy chỉnh không được vượt quá ${MAX_TENANT_AI_INSTRUCTIONS_LENGTH} ký tự`,
  })
  customInstructions?: string | null;

  @IsOptional()
  @IsBoolean({ message: 'Trạng thái kích hoạt chỉ dẫn AI phải là kiểu boolean' })
  enabled?: boolean;
}
