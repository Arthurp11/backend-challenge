import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { TransactionView } from '../../application/queries/views';
import { WageringQueries } from '../../application/queries/wagering-queries';
import { ProcessWagerTransaction } from '../../application/use-cases/process-wager-transaction';
import type { WagerTransactionResult } from '../../application/use-cases/wager-outcome';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { addLogContext, logger } from '../../infrastructure/observability/logger';
import { metrics } from '../../infrastructure/observability/metrics';
import { ProviderAuthGuard } from './provider-auth.guard';
import { idempotencyKeyHeader, textParam, uuidParam, validate, wagerTransactionBody } from './request-validation';

interface StatusSetter {
  status(code: number): unknown;
}

/**
 * Business outcome → HTTP status. Rejections are answers, not errors: 422 with the failureCode,
 * persisted and replayed identically. PENDING_REFERENCE is accepted for later processing (202).
 */
export function httpStatusFor(result: WagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
    case WagerTransactionStatus.PendingReference:
      return 202;
    default:
      return result.idempotentReplay ? 200 : 201;
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly queries: WageringQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<WagerTransactionResult> {
    const key = validate(idempotencyKeyHeader, idempotencyKey, 'Idempotency-Key header');
    const input = validate(wagerTransactionBody, body);
    addLogContext({ walletId: input.walletId, providerId: input.providerId });
    const started = performance.now();
    const result = await this.processWagerTransaction.execute({
      ...input,
      idempotencyKey: key,
      correlationId: correlationId ?? randomUUID(),
    });
    metrics.processingSeconds.observe({ source: 'http' }, (performance.now() - started) / 1_000);
    if (result.idempotentReplay) {
      metrics.duplicates.inc({ source: 'http' });
    } else {
      metrics.transactions.inc({ status: result.status, kind: input.kind, source: 'http' });
    }
    logger.info({ transactionId: result.transactionId, status: result.status, replay: result.idempotentReplay }, 'transaction handled');
    response.status(httpStatusFor(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  getTransaction(@Param('transactionId') transactionId: string): Promise<TransactionView> {
    return this.queries.getTransaction(validate(uuidParam, transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.queries.getTransactionByExternalId(
      validate(textParam, providerId, 'providerId'),
      validate(textParam, externalTransactionId, 'externalTransactionId'),
    );
  }
}
