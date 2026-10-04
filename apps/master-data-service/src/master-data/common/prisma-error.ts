import { ConflictException } from '@nestjs/common';

/** Prisma unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * The unique indexes are the authority on per-tenant uniqueness (BR-TEN-003).
 * A pre-check only produces a nicer message on the uncontended path, so every
 * write still funnels its failure through here.
 */
export function toConflict(error: unknown, message: string): never {
  if (isUniqueViolation(error)) {
    throw new ConflictException(message);
  }
  throw error;
}
