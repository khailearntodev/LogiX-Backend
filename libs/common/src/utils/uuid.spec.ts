import { describe, expect, it } from 'vitest';
import { generateId } from '../index.js';

describe('generateId', () => {
  it('returns a UUID with version 4 and RFC variant bits', () => {
    expect(generateId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('generates distinct identifiers for successive events', () => {
    expect(generateId()).not.toBe(generateId());
  });
});
