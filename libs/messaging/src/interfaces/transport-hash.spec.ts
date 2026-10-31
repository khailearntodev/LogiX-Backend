import { describe, expect, it } from 'vitest';
import { canonicalizeTransportPayload, hashTransportContractPayload } from './transport-hash.js';

describe('transport canonical payload hash v1', () => {
  it('uses sorted ASCII keys, compact JSON, UTF-8 and SHA-256 lowercase hex', () => {
    expect(canonicalizeTransportPayload({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(hashTransportContractPayload({ b: 2, a: 1 })).toBe(
      '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    );
    expect(canonicalizeTransportPayload({ name: 'Tài xế', quantity: '1.000' }))
      .toBe('{"name":"Tài xế","quantity":"1.000"}');
  });

  it('preserves array order and rejects floats rather than silently losing Decimal precision', () => {
    expect(hashTransportContractPayload({ ids: ['a', 'b'] }))
      .not.toBe(hashTransportContractPayload({ ids: ['b', 'a'] }));
    expect(() => canonicalizeTransportPayload({ quantity: 0.1 })).toThrow(/decimal strings/);
    expect(() => canonicalizeTransportPayload({ version: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integers/);
    expect(() => canonicalizeTransportPayload({ version: -0 })).toThrow(/safe integers/);
  });
});
