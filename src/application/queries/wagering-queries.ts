import { TransactionNotFoundError, WalletNotFoundError } from '../errors';
import type { UnitOfWork } from '../ports/unit-of-work';
import { type TransactionView, toTransactionView, toWalletView, type WalletView } from './views';

/** Read-only lookups for the GET endpoints. */
export class WageringQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run(({ wallets }) => wallets.findById(walletId));
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return toWalletView(wallet);
  }

  async getTransaction(transactionId: string): Promise<TransactionView> {
    const transaction = await this.uow.run(({ transactions }) => transactions.findById(transactionId));
    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }
    return toTransactionView(transaction);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const transaction = await this.uow.run(({ transactions }) => transactions.findByExternalId(providerId, externalTransactionId));
    if (!transaction) {
      throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    }
    return toTransactionView(transaction);
  }
}
