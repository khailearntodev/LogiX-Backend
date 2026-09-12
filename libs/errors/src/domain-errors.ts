import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes.js';

/**
 * DomainError — Abstract base class for all business domain errors.
 *
 * Domain errors carry a machine-readable error code and an HTTP status mapping.
 * They are caught by the GlobalExceptionFilter and serialized into a
 * standardized JSON error response.
 *
 * Services should throw domain errors instead of raw HttpExceptions to
 * separate business logic from HTTP transport concerns.
 */
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;

  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * EntityNotFoundError — Thrown when a requested entity does not exist
 * within the current tenant scope.
 */
export class EntityNotFoundError extends DomainError {
  readonly code = ErrorCode.ENTITY_NOT_FOUND;
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor(entityName: string, entityId: string) {
    super(`${entityName} with id '${entityId}' not found`, {
      entityName,
      entityId,
    });
  }
}

/**
 * BusinessRuleViolationError — Thrown when a business invariant is violated.
 *
 * Examples: insufficient stock, invalid order state transition,
 * capacity exceeded on a delivery trip.
 */
export class BusinessRuleViolationError extends DomainError {
  readonly code = ErrorCode.BUSINESS_RULE_VIOLATION;
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(
    rule: string,
    details?: Record<string, unknown>,
  ) {
    super(`Business rule violated: ${rule}`, details);
  }
}

/**
 * ConcurrencyConflictError — Thrown on optimistic versioning conflicts.
 *
 * @see docs/architecture/system-overview.md §6 — optimistic versioning
 */
export class ConcurrencyConflictError extends DomainError {
  readonly code = ErrorCode.CONCURRENCY_CONFLICT;
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor(
    entityName: string,
    entityId: string,
    expectedVersion: number,
    actualVersion: number,
  ) {
    super(
      `Concurrency conflict on ${entityName} '${entityId}': ` +
        `expected version ${expectedVersion}, found ${actualVersion}`,
      { entityName, entityId, expectedVersion, actualVersion },
    );
  }
}

/**
 * TenantAccessDeniedError — Thrown when an operation attempts to access
 * data belonging to a different tenant.
 *
 * @see Architecture principle #4 — tenant isolation is system-wide invariant
 */
export class TenantAccessDeniedError extends DomainError {
  readonly code = ErrorCode.TENANT_ACCESS_DENIED;
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('Access denied: operation crosses tenant boundary');
  }
}

/**
 * ValidationError — Thrown when input data fails validation rules.
 */
export class ValidationError extends DomainError {
  readonly code = ErrorCode.VALIDATION_FAILED;
  readonly httpStatus = HttpStatus.BAD_REQUEST;

  constructor(
    message: string,
    validationErrors?: Record<string, string[]>,
  ) {
    super(
      message,
      validationErrors ? { validationErrors } : undefined,
    );
  }
}

/**
 * InvalidStateTransitionError — Thrown when a state machine transition
 * is not allowed from the current state.
 */
export class InvalidStateTransitionError extends DomainError {
  readonly code = ErrorCode.INVALID_STATE_TRANSITION;
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(
    entityName: string,
    currentState: string,
    attemptedState: string,
  ) {
    super(
      `Invalid state transition for ${entityName}: ` +
        `cannot transition from '${currentState}' to '${attemptedState}'`,
      { entityName, currentState, attemptedState },
    );
  }
}

/**
 * DuplicateEntityError — Thrown when attempting to create an entity
 * that already exists (unique constraint violation).
 */
export class DuplicateEntityError extends DomainError {
  readonly code = ErrorCode.DUPLICATE_ENTITY;
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor(entityName: string, conflictField: string, value: string) {
    super(
      `${entityName} with ${conflictField} '${value}' already exists`,
      { entityName, conflictField, value },
    );
  }
}
