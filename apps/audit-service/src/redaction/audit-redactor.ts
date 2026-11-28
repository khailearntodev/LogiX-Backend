/**
 * Pure recursive secret/token redactor for immutable audit records (NFR-AUD-001).
 *
 * Ensures raw passwords, tokens, secrets, API keys, cookies, credentials, and
 * embedded connection-string passwords are never persisted in audit_logs.
 */

export const REDACTED_VALUE = '[REDACTED]';
export const TRUNCATED_VALUE = '[TRUNCATED]';
export const CIRCULAR_VALUE = '[CIRCULAR]';

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ARRAY_LENGTH = 100;
const DEFAULT_MAX_STRING_LENGTH = 4000;

const SENSITIVE_KEY_TOKENS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'set_cookie',
  'credential',
  'private_key',
  'privatekey',
  'otp',
  'pin',
  'ssn',
  'cvv',
  'card_number',
] as const;

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i;
const API_KEY_PATTERN = /\b(?:sk|pk|AIza)[A-Za-z0-9_-]{16,}\b/;
const CONNECTION_URI_SECRET_PATTERN =
  /\b(?:postgres(?:ql)?|redis|rediss|amqp|amqps|mongodb(?:\+srv)?):\/\/[^/\s:@]*:[^/\s@]+@/i;

export interface RedactOptions {
  maxDepth?: number;
  maxArrayLength?: number;
  maxStringLength?: number;
}

export function isSensitiveAuditKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll('-', '_');
  return SENSITIVE_KEY_TOKENS.some((token) => normalized.includes(token));
}

export function redactAuditString(value: string, maxStringLength = DEFAULT_MAX_STRING_LENGTH): string {
  if (
    JWT_PATTERN.test(value) ||
    BEARER_PATTERN.test(value) ||
    API_KEY_PATTERN.test(value) ||
    CONNECTION_URI_SECRET_PATTERN.test(value)
  ) {
    return REDACTED_VALUE;
  }
  if (value.length > maxStringLength) {
    return `${value.slice(0, maxStringLength)}...${TRUNCATED_VALUE}`;
  }
  return value;
}

function redactRecursive(
  value: unknown,
  depth: number,
  maxArrayLength: number,
  maxStringLength: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return redactAuditString(value, maxStringLength);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (depth <= 0) {
    return TRUNCATED_VALUE;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return CIRCULAR_VALUE;
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const sliced = value.slice(0, maxArrayLength);
        const mapped = sliced.map((item) =>
          redactRecursive(item, depth - 1, maxArrayLength, maxStringLength, seen),
        );
        if (value.length > maxArrayLength) {
          mapped.push(TRUNCATED_VALUE);
        }
        return mapped;
      }

      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (entry === undefined) continue;
        if (isSensitiveAuditKey(key)) {
          out[key] = REDACTED_VALUE;
        } else {
          out[key] = redactRecursive(entry, depth - 1, maxArrayLength, maxStringLength, seen);
        }
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }

  return redactAuditString(String(value), maxStringLength);
}

export function redactAuditPayload(
  value: unknown,
  options: RedactOptions = {},
): unknown {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  return redactRecursive(value, maxDepth, maxArrayLength, maxStringLength, new WeakSet<object>());
}
