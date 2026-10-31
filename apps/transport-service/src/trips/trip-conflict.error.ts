import { DomainError, ErrorCode } from '@logix/errors';

export class TripConflictError extends DomainError {
  readonly code = ErrorCode.BUSINESS_RULE_VIOLATION;
  readonly httpStatus = 409;

  constructor(rule: string, details?: Record<string, unknown>) {
    super(`Business rule violated: ${rule}`, details);
  }
}
