import { Money, type MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { UniqueViolationError, WalletAlreadyExistsError } from '../errors';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { UnitOfWork } from '../ports/unit-of-work';
import { toWalletView, type WalletView } from '../queries/views';
import { outboxMessagesFor } from './wager-outcome';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

/**
 * Opens a wallet. A positive initial balance is an internal OPENING transaction with its CREDIT entry
 * and events, all in the same SQL transaction as the wallet row (the deferred schema trigger checks it).
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    const at = this.clock.now();
    const walletId = this.ids.next();
    const opening = WagerTransaction.opening({
      id: this.ids.next(),
      walletId,
      playerId: command.playerId,
      money: initialBalance,
      createdAt: at,
    });
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      opening: { transactionId: opening.id, entryId: this.ids.next() },
      at,
    });
    if (openingEntry) {
      opening.markProcessed(undefined, at, wallet.balance);
    }

    try {
      await this.uow.run(async ({ wallets, transactions, ledger, outbox }) => {
        await wallets.insert(wallet);
        if (openingEntry) {
          await transactions.insert(opening);
          await ledger.insert(openingEntry);
          await outbox.enqueue(
            outboxMessagesFor(opening, wallet, openingEntry, () => ({
              eventId: this.ids.next(),
              correlationId: command.correlationId,
              occurredAt: at,
            })),
          );
        }
      });
    } catch (error) {
      // The wallet id is new, so the only unique key a new wallet can hit is (player, currency).
      if (error instanceof UniqueViolationError) {
        throw new WalletAlreadyExistsError(command.playerId, wallet.currency);
      }
      throw error;
    }
    return toWalletView(wallet);
  }
}
