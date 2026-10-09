import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import {
  ApplicationError,
  ConcurrentModificationError,
  ExternalIdConflictError,
  IdempotencyConflictError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { DomainError } from '../../domain/shared/domain-error';
import { logger } from '../../infrastructure/observability/logger';
import { metrics } from '../../infrastructure/observability/metrics';
import { RequestValidationError } from './request-validation';

export interface ErrorBody {
  code: string;
  message: string;
  /** Whether resending the same request (same Idempotency-Key) may succeed. */
  retryable: boolean;
  issues?: ReadonlyArray<{ path: string; message: string }>;
}

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/**
 * One mapping for every endpoint, so a provider decides by status code and `code`, never by parsing
 * messages: 400 invalid payload, 404 unknown resource, 409 conflict, 503 transient (retry later).
 * Business rejections are not errors: they are 422 responses built by the controller.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    if (error instanceof HttpException) {
      response.status(error.getStatus()).json(error.getResponse());
      return;
    }
    const { status, body } = toHttpError(error);
    if (status === 503) {
      response.setHeader('Retry-After', '1');
    }
    if (status === 409) {
      metrics.conflicts.inc({ code: body.code });
    }
    if (status === 500) {
      logger.error({ err: error }, 'unhandled error');
    } else if (status === 503) {
      logger.warn({ err: error }, 'transient failure answered with 503');
    }
    response.status(status).json(body);
  }
}

export function toHttpError(error: unknown): { status: number; body: ErrorBody } {
  const body = (code: string, message: string, retryable: boolean): ErrorBody => ({ code, message, retryable });

  if (error instanceof RequestValidationError) {
    return { status: 400, body: { ...body(error.code, error.message, false), issues: error.issues } };
  }
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
    return { status: 404, body: body(error.code, error.message, false) };
  }
  if (error instanceof IdempotencyConflictError || error instanceof ExternalIdConflictError || error instanceof WalletAlreadyExistsError) {
    return { status: 409, body: body(error.code, error.message, false) };
  }
  if (error instanceof TransientInfrastructureError || error instanceof ConcurrentModificationError) {
    return { status: 503, body: body('SERVICE_UNAVAILABLE', 'temporary failure, retry with the same Idempotency-Key', true) };
  }
  if (error instanceof DomainError) {
    // Invalid money or transaction input (business rejections never reach this filter).
    return { status: 400, body: body(error.code, error.message, false) };
  }
  if (error instanceof ApplicationError) {
    return { status: 400, body: body(error.code, error.message, false) };
  }
  // Unknown failure: retrying with the same Idempotency-Key is safe, it can never apply twice.
  return { status: 500, body: body('INTERNAL_ERROR', 'unexpected error', true) };
}
