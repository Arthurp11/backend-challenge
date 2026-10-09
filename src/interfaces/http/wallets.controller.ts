import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { WalletView } from '../../application/queries/views';
import { type LedgerPage, WalletLedgerQueries } from '../../application/queries/wallet-ledger-queries';
import { WageringQueries } from '../../application/queries/wagering-queries';
import { CreateWallet } from '../../application/use-cases/create-wallet';
import type { MoneyProps } from '../../domain/money/money';
import { logger } from '../../infrastructure/observability/logger';
import { metrics } from '../../infrastructure/observability/metrics';
import { ProviderAuthGuard } from './provider-auth.guard';
import { createWalletBody, ledgerQuery, uuidParam, validate } from './request-validation';

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  issues: string[];
}

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly queries: WageringQueries,
    private readonly ledgerQueries: WalletLedgerQueries,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Headers('x-correlation-id') correlationId: string | undefined): Promise<WalletView> {
    const input = validate(createWalletBody, body);
    return this.createWallet.execute({ ...input, correlationId: correlationId ?? randomUUID() });
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.queries.getWallet(validate(uuidParam, walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query() query: unknown): Promise<LedgerPage> {
    const { cursor, limit } = validate(ledgerQuery, query, 'query');
    return this.ledgerQueries.ledgerPage(validate(uuidParam, walletId, 'walletId'), cursor, limit);
  }

  /** Divergences are never corrected silently: they are logged, counted and flagged in the response. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string): Promise<ReconciliationView> {
    const report = await this.ledgerQueries.reconcile(validate(uuidParam, walletId, 'walletId'));
    if (!report.consistent) {
      metrics.reconciliationDivergences.inc();
      logger.error(
        { walletId, difference: report.difference.toJSON().amount, issues: report.issues },
        'reconciliation divergence: stored balance does not match the ledger',
      );
    }
    return {
      walletId: report.walletId,
      storedBalance: report.storedBalance.toJSON(),
      calculatedBalance: report.calculatedBalance.toJSON(),
      difference: report.difference.toJSON(),
      consistent: report.consistent,
      checkedEntries: report.checkedEntries,
      issues: report.issues,
    };
  }
}
