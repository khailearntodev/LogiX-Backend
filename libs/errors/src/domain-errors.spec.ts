import { describe, expect, it } from 'vitest';
import {
  BusinessRuleViolationError,
  ConcurrencyConflictError,
  DomainError,
  DuplicateEntityError,
  EntityNotFoundError,
  InvalidStateTransitionError,
  TenantAccessDeniedError,
  ValidationError,
} from './domain-errors.js';
import { ErrorCode } from './error-codes.js';

describe('domain error contracts', () => {
  it.each([
    [new EntityNotFoundError('Shipment', 'shipment-id'), ErrorCode.ENTITY_NOT_FOUND, 404],
    [new BusinessRuleViolationError('stock'), ErrorCode.BUSINESS_RULE_VIOLATION, 422],
    [new ConcurrencyConflictError('Shipment', 'shipment-id', 1, 2), ErrorCode.CONCURRENCY_CONFLICT, 409],
    [new TenantAccessDeniedError(), ErrorCode.TENANT_ACCESS_DENIED, 403],
    [new ValidationError('Invalid version'), ErrorCode.VALIDATION_FAILED, 400],
    [new InvalidStateTransitionError('Shipment', 'PENDING_PICK', 'READY_TO_SHIP'), ErrorCode.INVALID_STATE_TRANSITION, 422],
    [new DuplicateEntityError('Shipment', 'orderId', 'order-id'), ErrorCode.DUPLICATE_ENTITY, 409],
  ] as const)('maps %s to %s and HTTP %s', (error, code, status) => {
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe(error.constructor.name);
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(status);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it('preserves expected and actual versions for conflict recovery', () => {
    const error = new ConcurrencyConflictError('Shipment', 'shipment-id', 1, 2);
    expect(error.details).toEqual({
      entityName: 'Shipment',
      entityId: 'shipment-id',
      expectedVersion: 1,
      actualVersion: 2,
    });
    expect(error.message).toContain('expected version 1, found 2');
  });

  it('preserves validation fields without inventing details when absent', () => {
    expect(new ValidationError('Invalid version', { version: ['must be positive'] }).details)
      .toEqual({ validationErrors: { version: ['must be positive'] } });
    expect(new ValidationError('Invalid version').details).toBeUndefined();
  });
});
