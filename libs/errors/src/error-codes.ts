/**
 * Standardized error codes for the LogiX platform.
 *
 * All services use the same error code vocabulary to ensure consistent
 * error responses across the system.
 */
export const ErrorCode = {
  // --- Validation errors (400) ---
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INVALID_INPUT: 'INVALID_INPUT',

  // --- Authentication/Authorization errors (401, 403) ---
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  TENANT_ACCESS_DENIED: 'TENANT_ACCESS_DENIED',

  // --- Not found errors (404) ---
  ENTITY_NOT_FOUND: 'ENTITY_NOT_FOUND',

  // --- Conflict errors (409) ---
  CONCURRENCY_CONFLICT: 'CONCURRENCY_CONFLICT',
  DUPLICATE_ENTITY: 'DUPLICATE_ENTITY',

  // --- Business rule errors (422) ---
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',

  // --- Internal errors (500) ---
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  DOWNSTREAM_ERROR: 'DOWNSTREAM_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
