import { HttpStatus } from '@nestjs/common';
import { DomainError, ErrorCode } from '@logix/errors';

export class DownstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly definite: boolean,
  ) {
    super(message);
    this.name = 'DownstreamError';
  }
}

export class DownstreamServiceError extends DomainError {
  readonly code: typeof ErrorCode.SERVICE_UNAVAILABLE | typeof ErrorCode.DOWNSTREAM_ERROR;
  readonly httpStatus: number;

  constructor(
    service: string,
    status: number | null,
  ) {
    super(`${service} is unavailable or rejected the request`, {
      service,
      downstreamStatus: status,
    });
    this.code = status === null || status >= 500
      ? ErrorCode.SERVICE_UNAVAILABLE
      : ErrorCode.DOWNSTREAM_ERROR;
    this.httpStatus = status === null || status >= 500
      ? HttpStatus.SERVICE_UNAVAILABLE
      : HttpStatus.BAD_GATEWAY;
  }
}
