import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from './domain-errors.js';
import { ErrorCode } from './error-codes.js';

/**
 * Standardized error response envelope.
 *
 * Every error response from any LogiX service follows this structure
 * for consistent client-side error handling.
 */
interface ErrorResponse {
  statusCode: number;
  error: ErrorCode | string;
  message: string;
  details?: Record<string, unknown>;
  correlationId?: string;
  timestamp: string;
}

/**
 * GlobalExceptionFilter — Catches all exceptions and returns a
 * standardized JSON error response.
 *
 * Priority:
 * 1. DomainError subclasses → mapped to their code + httpStatus
 * 2. NestJS HttpExceptions → mapped as-is
 * 3. Unknown errors → 500 Internal Server Error (sanitized in production)
 *
 * All errors are logged with structured context including correlationId
 * and tenantId when available.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const errorResponse = this.buildErrorResponse(exception, request);

    // Log the error with structured context
    const logContext = {
      correlationId: errorResponse.correlationId,
      tenantId: request.headers['x-tenant-id'],
      method: request.method,
      path: request.url,
      statusCode: errorResponse.statusCode,
      error: errorResponse.error,
    };

    if (errorResponse.statusCode >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.message : 'Unknown error',
        exception instanceof Error ? exception.stack : undefined,
        logContext,
      );
    } else {
      this.logger.warn(errorResponse.message, logContext);
    }

    response.status(errorResponse.statusCode).json(errorResponse);
  }

  private buildErrorResponse(
    exception: unknown,
    request: Request,
  ): ErrorResponse {
    const correlationId =
      (request.headers['x-correlation-id'] as string) ?? undefined;
    const timestamp = new Date().toISOString();
    const isProduction = process.env.NODE_ENV === 'production';

    // 1. Domain errors — our business error hierarchy
    if (exception instanceof DomainError) {
      return {
        statusCode: exception.httpStatus,
        error: exception.code,
        message: exception.message,
        details: exception.details,
        correlationId,
        timestamp,
      };
    }

    // 2. NestJS HttpExceptions (e.g., from Guards, Pipes, built-in validators)
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      const message =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : (exceptionResponse as { message?: string }).message ??
            exception.message;

      return {
        statusCode: status,
        error: HttpStatus[status] ?? 'UNKNOWN',
        message,
        correlationId,
        timestamp,
      };
    }

    // 3. Unknown errors — sanitize in production
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: ErrorCode.INTERNAL_ERROR,
      message: isProduction
        ? 'An unexpected error occurred'
        : exception instanceof Error
          ? exception.message
          : 'Unknown error',
      correlationId,
      timestamp,
    };
  }
}
