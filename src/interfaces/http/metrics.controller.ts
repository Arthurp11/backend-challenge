import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { UnitOfWork } from '../../application/ports/unit-of-work';
import { metrics, registry } from '../../infrastructure/observability/metrics';
import { UNIT_OF_WORK } from '../../infrastructure/tokens';

/** Prometheus scrape endpoint. Outbox lag is measured at scrape time from the database. */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  @Get()
  @Header('Content-Type', registry.contentType)
  async scrape(): Promise<string> {
    const backlog = await this.uow.run(({ outbox }) => outbox.backlog()).catch(() => undefined);
    if (backlog) {
      metrics.outboxPending.set(backlog.pending);
      metrics.outboxLagSeconds.set(backlog.oldestOccurredAt ? (Date.now() - backlog.oldestOccurredAt.getTime()) / 1_000 : 0);
    }
    return registry.metrics();
  }
}
