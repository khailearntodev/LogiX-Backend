import { BadRequestException } from '@nestjs/common';

export const MAX_TENANT_AI_INSTRUCTIONS_LENGTH = 2000;

/**
 * Strips non-printable ASCII control characters (except \n and \t) and
 * invisible zero-width characters before validating length and safety.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_AND_ZERO_WIDTH_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g;

/**
 * Reserved prompt boundary tags and model control tokens that a tenant
 * instruction must never inject into the planner system prompt.
 */
const FORBIDDEN_DELIMITER_PATTERNS: readonly RegExp[] = [
  /\[\/?\s*TENANT\s+CUSTOM\s+INSTRUCTIONS[^\]]*\]/i,
  /\[\/?\s*IMMUTABLE\s+PLATFORM\s+GUARDRAILS[^\]]*\]/i,
  /\[\/?\s*USER\s+LONG-TERM\s+MEMORY[^\]]*\]/i,
  /\[\/?\s*SYSTEM(?:\s+PROMPT|\s+INSTRUCTION|\s+POLICY)?\s*\]/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /<\|system\|>/i,
  /<\|assistant\|>/i,
  /<\|user\|>/i,
  /<\|endoftext\|>/i,
  /<<\s*SYS\s*>>/i,
  /\[\/?\s*INST\s*\]/i,
  /^#{2,6}\s*(?:SYSTEM|GUARDRAILS?|INSTRUCTION\s+OVERRIDE)\b/im,
  /<\/?\s*(?:system|system_prompt|guardrails?|instructions?)\s*>/i,
];

/**
 * Prompt-injection / jailbreak patterns categorized across 5 security domains:
 * 1. System Prompt Override / Jailbreak / Persona Hijacking (EN & VI)
 * 2. Confirmation Gate / Human-in-the-Loop Bypass (EN & VI)
 * 3. Quantitative Engine (Prophet / OR-Tools) Bypass & Data Fabrication (EN & VI)
 * 4. RBAC / Privilege Escalation & Cross-Tenant Isolation Breach (EN & VI)
 * 5. System Prompt / Secret / Token / Credential Exfiltration (EN & VI)
 */
const FORBIDDEN_OVERRIDE_PATTERNS: readonly RegExp[] = [
  // ── 1. System Prompt Override / Jailbreak / Persona Hijacking (EN) ──
  /\b(?:ignore|disregard|forget|override|overwrite|replace|bypass|skip|void|nullify)(?:\s+(?:all|any|the|your|previous|prior|above|earlier|original|initial|preceding|system|core|platform|safety|security|default|existing))+\s+(?:instructions?|prompts?|rules?|guardrails?|policies|constraints?|directives?|guidelines?|boundaries)\b/i,
  /\b(?:you\s+are\s+now|switch\s+to|enter|enable|activate)\s+(?:in\s+)?(?:developer|god|sudo|root|unrestricted|unfiltered|jailbreak|dan|debug|maintenance|admin\s+override)\s+mode\b/i,
  /\bact\s+as\s+(?:an?\s+)?(?:unrestricted|unfiltered|jailbroken|uncensored|root|super\s*admin)\b/i,
  /\bnew\s+system\s+(?:prompt|instructions?|rules?|policy)\s*:/i,

  // ── 1. System Prompt Override / Jailbreak / Persona Hijacking (VI) ──
  /(?:bỏ\s+qua|phớt\s+lờ|quên\s+đi|ghi\s+đè|thay\s+thế|xóa\s+bỏ|vô\s+hiệu(?:\s+hóa)?|hủy\s+bỏ)\s+(?:mọi\s+|tất\s+cả\s+|các\s+|toàn\s+bộ\s+)?(?:chỉ\s+dẫn|quy\s+tắc|hướng\s+dẫn|ràng\s+buộc|câu\s+lệnh|thiết\s+lập|chính\s+sách|nguyên\s+tắc)(?:\s+(?:trước\s+đó|phía\s+trên|ở\s+trên|hệ\s+thống|gốc|ban\s+đầu|an\s+toàn|bảo\s+mật|cốt\s+lõi|mặc\s+định|nền\s+tảng))+/i,
  /(?:chuyển\s+sang|kích\s+hoạt|bật)\s+chế\s+độ\s+(?:không\s+giới\s+hạn|nhà\s+phát\s+triển|developer|debug|god|toàn\s+quyền|vượt\s+quyền|jailbreak)/i,

  // ── 2. Confirmation Gate / Human-in-the-Loop Bypass (EN) ──
  /\b(?:bypass|skip|disable|turn\s+off|omit|suppress|circumvent)(?:\s+(?:all|any|the|user|human|explicit))*\s+(?:confirmations?|approvals?|previews?|confirmation\s+gates?|approval\s+cards?|interrupts?|human\s+reviews?|user\s+consents?)\b/i,
  /\b(?:never|do\s+not|don't|stop)\s+(?:ask|require|request|wait|prompt|pause|show)(?:\s+\w+){0,3}\s+(?:for\s+)?(?:confirmation|approval|preview|consent)\b/i,
  /\b(?:auto(?:matically)?[-\s]*approve|auto(?:matically)?[-\s]*confirm|execute\s+without\s+(?:confirmation|approval|preview|asking))\b/i,

  // ── 2. Confirmation Gate / Human-in-the-Loop Bypass (VI) ──
  /(?:bỏ\s+qua|tắt|vô\s+hiệu(?:\s+hóa)?|không\s+(?:cần|phải|được)\s+(?:yêu\s+cầu|hỏi|hiển\s+thị|chờ)|tự\s+động\s+(?:duyệt|xác\s+nhận|phê\s+duyệt))\s+(?:bước\s+|thẻ\s+|cổng\s+)?(?:xác\s+nhận|phê\s+duyệt|xem\s+trước|preview)(?:\s+của\s+người\s+dùng)?/i,
  /thực\s+thi\s+(?:thẳng|trực\s+tiếp|ngay)(?:\s+mà)?\s+không\s+cần\s+(?:xác\s+nhận|phê\s+duyệt|hỏi\s+lại)/i,

  // ── 3. Quantitative Tools (Prophet / OR-Tools) Bypass & Data Fabrication (EN) ──
  /\b(?:do\s+not|don't|never|stop|avoid|skip)\s+(?:use|using|call|calling|invoke|invoking|run|running)\s+(?:the\s+)?(?:prophet|or-tools|google\s+or-tools|forecast(?:ing)?\s+tools?|route\s+optimiz(?:er|ation)\s+tools?|verified\s+tools?)\b/i,
  /\b(?:invent|fabricate|fake|make\s+up|hallucinate|guess)\s+(?:business\s+|operational\s+|order\s+|inventory\s+|forecast\s+|route\s+)?(?:data|numbers|metrics|results|records|forecasts?|routes?)\b/i,
  /\b(?:calculate|compute|estimate|generate)\s+(?:the\s+)?(?:demand\s+forecasts?|delivery\s+routes?|shortest\s+paths?)\s+(?:yourself|directly|manually|internally|without\s+tools?)\b/i,

  // ── 3. Quantitative Tools (Prophet / OR-Tools) Bypass & Data Fabrication (VI) ──
  /không\s+(?:cần\s+|được\s+|phải\s+)?(?:gọi|dùng|sử\s+dụng|chạy|thực\s+thi)\s+(?:công\s+cụ\s+|tool\s+|mô\s+hình\s+|bộ\s+giải\s+)?(?:prophet|or-tools|dự\s+báo|tối\s+ưu\s+tuyến)/i,
  /tự\s+(?:tính(?:\s+toán)?|ước\s+lượng|sinh|bịa|chế|đoán)\s+(?:kết\s+quả\s+|số\s+liệu\s+|dữ\s+liệu\s+)?(?:dự\s+báo|nhu\s+cầu|tuyến\s+đường|lộ\s+trình|tồn\s+kho|đơn\s+hàng)/i,

  // ── 4. RBAC / Privilege Escalation & Cross-Tenant Isolation Breach (EN) ──
  /\b(?:bypass|ignore|skip|disable|override|circumvent)(?:\s+(?:all|any|the))?\s+(?:rbac|permissions?|role\s+checks?|access\s+controls?|authorizations?|tenant\s+isolation|tenant\s+scopes?|tenant\s+boundaries)\b/i,
  /\b(?:treat|consider|assume)\s+(?:all\s+users|every\s+user|everyone|me|the\s+caller|the\s+user|members?)\s+as\s+(?:a\s+)?(?:super\s*admin|platform\s+admin|owner|tenant\s+admin|administrator)\b/i,
  /\bgrant\s+(?:all|full|admin|owner|unrestricted)\s+(?:permissions?|access|privileges|roles?|tools?)\b/i,
  /\b(?:access|query|read|fetch|show|leak|expose|switch\s+to)\s+(?:data|orders?|inventory|shipments?|trips?|members?|records?)\s+(?:from|of|belonging\s+to|across)\s+(?:other|another|all|different|foreign)\s+(?:tenants?|organizations?|companies)\b/i,

  // ── 4. RBAC / Privilege Escalation & Cross-Tenant Isolation Breach (VI) ──
  /(?:bỏ\s+qua|vô\s+hiệu(?:\s+hóa)?|vượt\s+qua|tắt)\s+(?:việc\s+|bước\s+)?(?:kiểm\s+tra\s+)?(?:quyền|phân\s+quyền|rbac|vai\s+trò|cô\s+lập\s+tổ\s+chức|cách\s+ly\s+tenant)/i,
  /coi\s+(?:mọi\s+người(?:\s+dùng)?|tất\s+cả\s+(?:user|thành\s+viên)|tôi|người\s+dùng\s+hiện\s+tại|member)\s+(?:như\s+)?là\s+(?:super\s*admin|chủ\s+sở\s+hữu|owner|quản\s+trị\s+viên|admin)/i,
  /(?:truy\s+cập|xem|đọc|lấy|hiển\s+thị|tiết\s+lộ)\s+dữ\s+liệu\s+(?:của\s+)?(?:tổ\s+chức\s+khác|tenant\s+khác|doanh\s+nghiệp\s+khác|toàn\s+bộ\s+các\s+tổ\s+chức)/i,

  // ── 5. System Prompt / Secret / Token / Credential Exfiltration (EN & VI) ──
  /\b(?:reveal|print|output|dump|show|leak|expose|repeat|echo|disclose)(?:\s+(?:me|us|all|the|your|entire|full|exact|raw|hidden|internal|verbatim))+\s+(?:system\s+prompt|hidden\s+instructions?|guardrails?|jwt|access\s+tokens?|refresh\s+tokens?|api\s+keys?|secrets?|credentials?|passwords?|database\s+urls?|connection\s+strings?|env(?:ironment)?\s+variables?)\b/i,
  /(?:tiết\s+lộ|in\s+ra|hiển\s+thị|xuất\s+ra|làm\s+lộ|đọc\s+nguyên\s+văn)\s+(?:toàn\s+bộ\s+|nguyên\s+văn\s+)?(?:system\s+prompt|prompt\s+hệ\s+thống|chỉ\s+dẫn\s+ẩn|chỉ\s+dẫn\s+gốc|access\s+token|refresh\s+token|jwt|mật\s+khẩu|api\s+key|khóa\s+bí\s+mật|biến\s+môi\s+trường|chuỗi\s+kết\s+nối)/i,
];

/**
 * Validates and normalizes tenant-scoped custom AI instructions.
 * Returns `null` when the input is `null`, `undefined`, or blank (reset to system default).
 * Throws `BadRequestException` when length or safety invariants are violated.
 */
export function validateAndNormalizeTenantAiInstructions(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  if (typeof raw !== 'string') {
    throw new BadRequestException('Chỉ dẫn AI tùy chỉnh phải là chuỗi ký tự hợp lệ');
  }

  const normalized = raw
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_AND_ZERO_WIDTH_RE, '')
    .trim();

  if (normalized.length === 0) {
    return null;
  }

  if (normalized.length > MAX_TENANT_AI_INSTRUCTIONS_LENGTH) {
    throw new BadRequestException(
      `Chỉ dẫn AI tùy chỉnh không được vượt quá ${MAX_TENANT_AI_INSTRUCTIONS_LENGTH} ký tự`,
    );
  }

  for (const pattern of FORBIDDEN_DELIMITER_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new BadRequestException(
        'Chỉ dẫn tùy chỉnh chứa thẻ cấu trúc hệ thống không được phép',
      );
    }
  }

  for (const pattern of FORBIDDEN_OVERRIDE_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new BadRequestException(
        'Chỉ dẫn tùy chỉnh chứa yêu cầu ghi đè quy tắc an toàn hệ thống không được phép',
      );
    }
  }

  return normalized;
}
