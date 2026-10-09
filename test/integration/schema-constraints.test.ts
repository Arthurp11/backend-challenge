import { beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { useTestDatabase } from '../support/test-database';

/*
 * Each guarantee of §6 is attacked with raw SQL, bypassing the application entirely:
 * the database alone must refuse (§5 rule 9).
 */

let orm: MikroORM;
beforeAll(async () => {
  orm = await useTestDatabase();
});

const uuid = () => Bun.randomUUIDv7();
const sql = (query: string, params: unknown[] = []) => orm.em.fork().getConnection().execute(query, params);
/** Several statements in one transaction: deferred triggers only fire at its commit. */
const inTransaction = (...statements: Array<[string, unknown[]]>) =>
  orm.em.fork().transactional(async (em) => {
    for (const [query, params] of statements) {
      await em.execute(query, params);
    }
  });

interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
}

const insertWalletSql = `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
  values (?, ?, ?, ?, 1, now(), now())`;

async function wallet(overrides: Partial<WalletRow> = {}): Promise<WalletRow> {
  const row = { id: uuid(), playerId: uuid(), currency: 'BRL', balance: '0.00', ...overrides };
  await sql(insertWalletSql, [row.id, row.playerId, row.currency, row.balance]);
  return row;
}

interface TransactionRow {
  id: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalId: string;
  idempotencyKey: string;
  kind: string;
  amount: string;
  currency: string;
  status: string;
  failureCode: string | null;
  referenceExternalId: string | null;
  referenceId: string | null;
  roundId: string | null;
  gameId: string | null;
}

function transactionInsert(owner: WalletRow, overrides: Partial<TransactionRow> = {}): [string, unknown[], TransactionRow] {
  const externalId = overrides.externalId ?? uuid();
  const row: TransactionRow = {
    id: uuid(),
    walletId: owner.id,
    playerId: owner.playerId,
    providerId: 'provider-a',
    externalId,
    idempotencyKey: `provider-a:${externalId}`,
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PROCESSED',
    failureCode: null,
    referenceExternalId: null,
    referenceId: null,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    ...overrides,
  };
  const pending = row.status === 'PENDING_REFERENCE';
  return [
    `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
       player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
       status, failure_code, result_balance_amount, result_balance_currency, next_reference_attempt_at, created_at, processed_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0.00', 'BRL', ${pending ? 'now()' : 'null'}, now(), ${pending ? 'null' : 'now()'})`,
    [
      row.id, row.providerId, row.externalId, row.idempotencyKey, 'a'.repeat(64), row.walletId, row.playerId, row.roundId,
      row.gameId, row.kind, row.amount, row.currency, row.referenceExternalId, row.referenceId, row.status, row.failureCode,
    ],
    row,
  ];
}

async function transaction(owner: WalletRow, overrides: Partial<TransactionRow> = {}): Promise<TransactionRow> {
  const [query, params, row] = transactionInsert(owner, overrides);
  await sql(query, params);
  return row;
}

interface EntryRow {
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  before: string;
  after: string;
  version: number;
}

function entryInsert(row: EntryRow): [string, unknown[]] {
  return [
    `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before,
       balance_after, wallet_version, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [uuid(), row.walletId, row.transactionId, row.direction, row.amount, row.currency, row.before, row.after, row.version],
  ];
}

/** A wallet with one valid CREDIT entry of 10.00 at version 2 (0.00 → 10.00), plus its transaction. */
async function walletWithEntry() {
  const owner = await wallet();
  const credit = await transaction(owner, { kind: 'WIN' });
  const entry: EntryRow = {
    walletId: owner.id,
    transactionId: credit.id,
    direction: 'CREDIT',
    amount: '10.00',
    currency: 'BRL',
    before: '0.00',
    after: '10.00',
    version: 2,
  };
  await inTransaction(entryInsert(entry), [`update wallets set balance_amount = '10.00', version = 2 where id = ?`, [owner.id]]);
  return { owner, credit, entry };
}

const violation = (code: string, constraint: string) => expect.objectContaining({ code, constraint });

describe('schema guarantees (raw SQL, no application code)', () => {
  describe('wallets', () => {
    it('balance can never be negative', async () => {
      await expect(wallet({ balance: '-0.01' })).rejects.toEqual(violation('23514', 'wallets_balance_non_negative'));
    });

    it('one wallet per player and currency', async () => {
      const first = await wallet();

      await expect(wallet({ playerId: first.playerId })).rejects.toEqual(violation('23505', 'wallets_player_currency_key'));
      await expect(wallet({ playerId: first.playerId, currency: 'USD' })).resolves.toBeDefined();
    });

    it('currency must be an ISO-4217 code', async () => {
      await expect(wallet({ currency: 'brl' })).rejects.toEqual(violation('23514', 'wallets_currency_format'));
    });
  });

  describe('balance and ledger cannot drift apart (deferred trigger, checked at commit)', () => {
    it('a wallet created with a positive balance needs its OPENING entry in the same transaction', async () => {
      await expect(wallet({ balance: '50.00' })).rejects.toThrow(/without a matching ledger entry/);
    });

    it('a balance change without a ledger entry is refused at commit', async () => {
      const owner = await wallet();

      await expect(
        inTransaction([`update wallets set balance_amount = '5.00', version = 2 where id = ?`, [owner.id]]),
      ).rejects.toThrow(/without a matching ledger entry/);
    });

    it('a balance change with the matching entry commits', async () => {
      const { owner } = await walletWithEntry();

      const [row] = await sql('select balance_amount, version from wallets where id = ?', [owner.id]);
      expect(row).toEqual({ balance_amount: '10.00', version: 2 });
    });

    it('version cannot move without the balance (a LOSS must not bump it)', async () => {
      const owner = await wallet();

      await expect(inTransaction([`update wallets set version = 2 where id = ?`, [owner.id]])).rejects.toThrow(
        /version must change by exactly 1/,
      );
    });
  });

  describe('wager_transactions', () => {
    it('the idempotency key is unique', async () => {
      const owner = await wallet();
      const first = await transaction(owner);

      await expect(transaction(owner, { idempotencyKey: first.idempotencyKey })).rejects.toEqual(
        violation('23505', 'wager_transactions_idempotency_key_key'),
      );
    });

    it('(provider, external id) is unique', async () => {
      const owner = await wallet();
      const first = await transaction(owner);

      await expect(transaction(owner, { externalId: first.externalId, idempotencyKey: 'other-key' })).rejects.toEqual(
        violation('23505', 'wager_transactions_provider_external_key'),
      );
    });

    it('PENDING is never committed (it only exists inside the processing transaction)', async () => {
      const owner = await wallet();

      await expect(transaction(owner, { status: 'PENDING' })).rejects.toEqual(violation('23514', 'wager_transactions_status_check'));
    });

    it('REFUND and ROLLBACK need a reference', async () => {
      const owner = await wallet();

      await expect(transaction(owner, { kind: 'REFUND' })).rejects.toEqual(
        violation('23514', 'wager_transactions_reference_required'),
      );
    });

    it('a REJECTED transaction carries its failure code', async () => {
      const owner = await wallet();

      await expect(transaction(owner, { status: 'REJECTED' })).rejects.toEqual(
        violation('23514', 'wager_transactions_failure_code_iff_failed'),
      );
    });

    it('only OPENING has no round', async () => {
      const owner = await wallet();

      await expect(transaction(owner, { roundId: null, gameId: null })).rejects.toEqual(
        violation('23514', 'wager_transactions_round_only_for_providers'),
      );
    });

    it('a reference is reversed at most once, by any reversal kind', async () => {
      const owner = await wallet();
      const bet = await transaction(owner);
      const reversal = { amount: bet.amount, referenceExternalId: bet.externalId, referenceId: bet.id };
      await transaction(owner, { kind: 'REFUND', ...reversal });

      await expect(transaction(owner, { kind: 'ROLLBACK', ...reversal })).rejects.toEqual(
        violation('23505', 'wager_transactions_single_reversal'),
      );
      // A rejected attempt is not a reversal, so it does not count.
      await expect(
        transaction(owner, { kind: 'ROLLBACK', status: 'REJECTED', failureCode: 'ALREADY_REVERSED', ...reversal }),
      ).resolves.toBeDefined();
    });

    it('a terminal transaction never changes again', async () => {
      const owner = await wallet();
      const bet = await transaction(owner);

      await expect(sql(`update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = ?`, [bet.id])).rejects.toThrow(
        /terminal\) and cannot change/,
      );
    });

    it('a PENDING_REFERENCE transaction may still be resolved', async () => {
      const owner = await wallet();
      const refund = await transaction(owner, { kind: 'REFUND', status: 'PENDING_REFERENCE', referenceExternalId: 'late-bet' });

      await expect(
        sql(
          `update wager_transactions set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND',
             next_reference_attempt_at = null, processed_at = now() where id = ?`,
          [refund.id],
        ),
      ).resolves.toBeDefined();
    });

    it('transactions are never deleted', async () => {
      const owner = await wallet();
      const refund = await transaction(owner, { kind: 'REFUND', status: 'PENDING_REFERENCE', referenceExternalId: 'late-bet' });

      await expect(sql('delete from wager_transactions where id = ?', [refund.id])).rejects.toThrow(/never deleted/);
    });
  });

  describe('wallet_ledger_entries', () => {
    it('the arithmetic must add up', async () => {
      const owner = await wallet();
      const bet = await transaction(owner);
      const wrong = { walletId: owner.id, transactionId: bet.id, direction: 'CREDIT', amount: '10.00', currency: 'BRL', before: '0.00', after: '15.00', version: 2 };

      await expect(sql(...entryInsert(wrong))).rejects.toEqual(violation('23514', 'wallet_ledger_entries_arithmetic'));
    });

    it('an entry always has the currency of its wallet', async () => {
      const owner = await wallet();
      const bet = await transaction(owner);
      const usdEntry = { walletId: owner.id, transactionId: bet.id, direction: 'CREDIT', amount: '10.00', currency: 'USD', before: '0.00', after: '10.00', version: 2 };

      await expect(sql(...entryInsert(usdEntry))).rejects.toEqual(violation('23503', 'wallet_ledger_entries_wallet_currency_fk'));
    });

    it('one entry per transaction per wallet', async () => {
      const { entry } = await walletWithEntry();

      await expect(sql(...entryInsert({ ...entry, version: 3 }))).rejects.toEqual(
        violation('23505', 'wallet_ledger_entries_wallet_transaction_key'),
      );
    });

    it('one entry per wallet version', async () => {
      const { owner, entry } = await walletWithEntry();
      const other = await transaction(owner, { kind: 'WIN' });

      await expect(sql(...entryInsert({ ...entry, transactionId: other.id }))).rejects.toEqual(
        violation('23505', 'wallet_ledger_entries_wallet_version_key'),
      );
    });

    it.each([
      ['UPDATE', `update wallet_ledger_entries set amount = amount where wallet_id = ?`],
      ['DELETE', `delete from wallet_ledger_entries where wallet_id = ?`],
    ])('is append-only: %s is refused', async (_operation, query) => {
      const { owner } = await walletWithEntry();

      await expect(sql(query, [owner.id])).rejects.toThrow(/append-only/);
    });

    it('is append-only: TRUNCATE is refused', async () => {
      await expect(sql('truncate wallet_ledger_entries cascade')).rejects.toThrow(/append-only/);
    });
  });

  describe('inbox_messages', () => {
    it('(consumer, messageId) is unique', async () => {
      const insert = `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('c', ?, 'h', now())`;
      const messageId = uuid();
      await sql(insert, [messageId]);

      await expect(sql(insert, [messageId])).rejects.toEqual(violation('23505', 'inbox_messages_pkey'));
    });
  });
});
