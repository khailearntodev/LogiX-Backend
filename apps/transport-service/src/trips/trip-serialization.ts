import { createHash } from 'node:crypto';
import { ValidationError } from '@logix/errors';

export function toSafeVersion(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('Transport version exceeds the supported safe integer range');
  }
  return number;
}

export function toSafeCounter(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error('Transport counter exceeds the supported safe integer range');
  }
  return number;
}

export function stableHash(value: unknown): string {
  const encode = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(encode);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, encode(entry)]),
      );
    }
    return item;
  };
  return createHash('sha256').update(JSON.stringify(encode(value))).digest('hex');
}

export function parseDto<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError('Request validation failed',
      Object.fromEntries(parsed.error.issues.map((issue) => [
        issue.path.join('.') || 'request',
        [issue.message],
      ])),
    );
  }
  return parsed.data;
}
