import { randomUUID } from 'node:crypto';
import type { NestMiddleware } from '@nestjs/common';
import { withLogContext } from '../../infrastructure/observability/logger';

interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
}
interface HttpResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Gives every request a correlation id (the caller's X-Correlation-Id, or a new one), echoes it back,
 * and opens the log context so every log line of this request carries it.
 */
export class RequestContextMiddleware implements NestMiddleware {
  use(request: HttpRequest, response: HttpResponse, next: () => void): void {
    const header = request.headers['x-correlation-id'];
    const correlationId = (Array.isArray(header) ? header[0] : header) || randomUUID();
    request.headers['x-correlation-id'] = correlationId;
    response.setHeader('X-Correlation-Id', correlationId);
    withLogContext({ correlationId }, next);
  }
}
