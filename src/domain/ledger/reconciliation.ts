import { Money } from '../money/money';
import type { Wallet } from '../wallet/wallet';
import { LedgerDirection } from './ledger-direction';
import type { WalletLedgerEntry } from './wallet-ledger-entry';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  /** stored − calculated: zero when consistent. */
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
  /** Human-readable findings besides the balance difference (corrupt entry, broken chain, version). */
  issues: string[];
}

/**
 * Rebuilds the balance from the ledger and compares it with the materialized balance. Also checks each
 * entry's arithmetic (`isBalanced`, a second line of defense behind the schema CHECK), that entries
 * chain (each starts where the previous ended) and that the last entry carries the wallet version.
 * It never corrects anything: divergences are reported, the caller logs and alerts.
 */
export function reconcile(wallet: Wallet, entries: readonly WalletLedgerEntry[]): ReconciliationReport {
  const issues: string[] = [];
  let calculated = Money.zero(wallet.currency);
  entries.forEach((entry, index) => {
    if (!entry.isBalanced()) {
      issues.push(`entry ${entry.id} (version ${entry.walletVersion}) does not add up`);
    }
    const previous = entries[index - 1];
    if (previous && !entry.balanceBefore.equals(previous.balanceAfter)) {
      issues.push(`chain broken at version ${entry.walletVersion}`);
    }
    if (entry.money.currency === wallet.currency) {
      calculated = entry.direction === LedgerDirection.Credit ? calculated.add(entry.money) : calculated.subtract(entry.money);
    } else {
      issues.push(`entry ${entry.id} is in ${entry.money.currency}, wallet is in ${wallet.currency}`);
    }
  });
  const last = entries.at(-1);
  if (last ? last.walletVersion !== wallet.version : wallet.version !== 1) {
    issues.push(`wallet version ${wallet.version} does not match the ledger (last entry version ${last?.walletVersion ?? 'none'})`);
  }
  const difference = wallet.balance.subtract(calculated);
  return {
    walletId: wallet.id,
    storedBalance: wallet.balance,
    calculatedBalance: calculated,
    difference,
    consistent: difference.isZero() && issues.length === 0,
    checkedEntries: entries.length,
    issues,
  };
}
