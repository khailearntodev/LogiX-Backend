import { randomUUID } from 'node:crypto';

/**
 * Generate a v4 UUID using Node.js built-in crypto.
 * Used for correlationId, eventId, and other unique identifiers.
 */
export function generateId(): string {
  return randomUUID();
}
