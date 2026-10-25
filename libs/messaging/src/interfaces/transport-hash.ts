import { createHash } from 'node:crypto';

export type TransportCanonicalValue =
  | null
  | boolean
  | string
  | number
  | TransportCanonicalValue[]
  | { [key: string]: TransportCanonicalValue };

/** Contract keys are ASCII; decimal measures must already be normalized strings. */
export function canonicalizeTransportPayload(value: TransportCanonicalValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error('Canonical transport numbers must be safe integers; use decimal strings for measures');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeTransportPayload).join(',')}]`;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Canonical transport payload must contain only JSON values');
  }
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !/^[\x20-\x7e]+$/.test(key))) {
    throw new Error('Canonical transport object keys must be printable ASCII');
  }
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeTransportPayload(value[key])}`).join(',')}}`;
}

export function hashTransportContractPayload(value: TransportCanonicalValue): string {
  return createHash('sha256').update(canonicalizeTransportPayload(value), 'utf8').digest('hex');
}
