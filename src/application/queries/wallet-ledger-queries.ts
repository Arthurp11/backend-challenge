import { type ReconciliationReport, reconcile } from '../../domain/ledger/reconciliation';
import { ApplicationError, WalletNotFoundError } from '../errors';
import type { UnitOfWork } from '../ports/unit-of-work';
import { type LedgerEntryView, toLedgerEntryView } from './views';

export interface LedgerPage {
  items: LedgerEntryView[];
  /** Opaque cursor for the next page, or null at the end. */
  nextCursor: string | null;
}

/** Ledger pagination and reconciliation, both read-only. */
export class WalletLedgerQueries {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * Keyset pagination on wallet_version (unique per wallet, only grows): stable while new entries are
   * appended, unlike OFFSET. The cursor is opaque to clients (base64url of the last version seen).
   */
  async ledgerPage(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const afterVersion = cursor === undefined ? undefined : decodeCursor(cursor);
    return this.uow.run(async ({ wallets, ledger }) => {
      if (!(await wallets.findById(walletId))) {
        throw new WalletNotFoundError(walletId);
      }
      const entries = await ledger.listByWallet(walletId, { afterVersion, limit: limit + 1 });
      const page = entries.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toLedgerEntryView),
        nextCursor: entries.length > limit && last ? encodeCursor(last.walletVersion) : null,
      };
    });
  }

  /** Reads wallet and ledger in one REPEATABLE READ snapshot: a concurrent commit cannot fake a divergence. */
  async reconcile(walletId: string): Promise<ReconciliationReport> {
    return this.uow.run(
      async ({ wallets, ledger }) => {
        const wallet = await wallets.findById(walletId);
        if (!wallet) {
          throw new WalletNotFoundError(walletId);
        }
        return reconcile(wallet, await ledger.listAllByWallet(walletId));
      },
      { snapshot: true },
    );
  }
}

export class InvalidCursorError extends ApplicationError {
  readonly code = 'INVALID_CURSOR';

  constructor() {
    super('invalid pagination cursor');
  }
}

function encodeCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const { v } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v: unknown };
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
      return v;
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError();
}
