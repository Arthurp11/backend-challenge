import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. Every guarantee of §6 lives here too, not only in application code:
 * uniqueness (unique keys and a partial unique index), immutability (append-only triggers) and
 * non-negativity (CHECKs), plus a deferred trigger that ties every balance change to a ledger entry.
 */
export class Migration0001InitialSchema extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency text not null,
        balance_amount numeric(20, 2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_key unique (player_id, currency),
        -- target of the ledger's composite foreign key: an entry always has its wallet's currency
        constraint wallets_id_currency_key unique (id, currency),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative check (balance_amount >= 0),
        constraint wallets_version_positive check (version >= 1)
      )`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets (id),
        player_id uuid not null,
        round_id text,
        game_id text,
        kind text not null,
        amount numeric(20, 2) not null,
        currency text not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions (id),
        status text not null,
        failure_code text,
        -- the wallet's balance when the transaction reached its status; its own currency, because a
        -- CURRENCY_MISMATCH rejection stores a balance in a currency different from the operation's
        result_balance_amount numeric(20, 2),
        result_balance_currency text,
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_transactions_idempotency_key_key unique (idempotency_key),
        constraint wager_transactions_provider_external_key unique (provider_id, external_transaction_id),
        constraint wager_transactions_payload_hash_format check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint wager_transactions_kind_check check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        -- PENDING only exists in memory, inside the processing transaction: it is never committed
        constraint wager_transactions_status_check check (status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_amount_check check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        constraint wager_transactions_reference_required check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_round_only_for_providers check ((kind = 'OPENING') = (round_id is null and game_id is null)),
        constraint wager_transactions_failure_code_iff_failed check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_processed_at_iff_terminal check ((status = 'PENDING_REFERENCE') = (processed_at is null)),
        constraint wager_transactions_schedule_iff_pending check ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at is not null)),
        constraint wager_transactions_result_balance check (
          (status = 'FAILED' or result_balance_amount is not null)
          and (result_balance_amount is null) = (result_balance_currency is null)
          and result_balance_amount >= 0
          and result_balance_currency ~ '^[A-Z]{3}$'
        ),
        constraint wager_transactions_processed_reference_resolved check (
          status <> 'PROCESSED' or reference_external_transaction_id is null or reference_transaction_id is not null
        ),
        constraint wager_transactions_reference_attempts check (reference_attempts >= 0)
      )`);

    // A reference can be reversed at most once, by any reversal kind (see ARCHITECTURE "Interpretações").
    this.addSql(`
      create unique index wager_transactions_single_reversal
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')`);
    this.addSql(`
      create index wager_transactions_pending_reference_due
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE'`);
    this.addSql(`create index wager_transactions_wallet on wager_transactions (wallet_id)`);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null references wager_transactions (id),
        direction text not null,
        amount numeric(20, 2) not null,
        currency text not null,
        balance_before numeric(20, 2) not null,
        balance_after numeric(20, 2) not null,
        wallet_version integer not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_wallet_currency_fk foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_wallet_transaction_key unique (wallet_id, transaction_id),
        -- one entry per wallet version: also the stable cursor of the ledger pagination
        constraint wallet_ledger_entries_wallet_version_key unique (wallet_id, wallet_version),
        constraint wallet_ledger_entries_direction_check check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entries_wallet_version_positive check (wallet_version >= 1),
        constraint wallet_ledger_entries_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      )`);

    this.addSql(`
      create function forbid_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % is not allowed', tg_op;
      end
      $$`);
    this.addSql(`
      create trigger wallet_ledger_entries_append_only
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_ledger_mutation()`);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_ledger_mutation()`);

    // Terminal transactions never change again, and no transaction is ever deleted (audit trail).
    this.addSql(`
      create function guard_wager_transaction_change() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions are never deleted (transaction %)', old.id;
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'transaction % is % (terminal) and cannot change', old.id, old.status;
        end if;
        return new;
      end
      $$`);
    this.addSql(`
      create trigger wager_transactions_terminal_is_final
        before update or delete on wager_transactions
        for each row execute function guard_wager_transaction_change()`);

    /*
     * Balance and ledger cannot drift apart: at commit time, every wallet insert with a positive balance
     * and every balance change must have the ledger entry for that exact version and resulting balance.
     * Deferred, because inside the transaction the wallet row and its entry are written one after the other.
     */
    this.addSql(`
      create function assert_balance_change_is_ledgered() returns trigger language plpgsql as $$
      begin
        if tg_op = 'INSERT' then
          if new.version <> 1 then
            raise exception 'wallet % must be created at version 1', new.id;
          end if;
          if new.balance_amount = 0 then
            return null;
          end if;
        else
          if new.version = old.version and new.balance_amount = old.balance_amount then
            return null;
          end if;
          if new.version <> old.version + 1 or new.balance_amount = old.balance_amount then
            raise exception 'wallet %: version must change by exactly 1, and only together with the balance', new.id;
          end if;
        end if;
        if not exists (
          select 1 from wallet_ledger_entries e
          where e.wallet_id = new.id and e.wallet_version = new.version and e.balance_after = new.balance_amount
        ) then
          raise exception 'wallet % reached version % (balance %) without a matching ledger entry',
            new.id, new.version, new.balance_amount;
        end if;
        return null;
      end
      $$`);
    this.addSql(`
      create constraint trigger wallets_balance_change_is_ledgered
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function assert_balance_change_is_ledgered()`);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      )`);

    // id is the eventId (uuidv7, time-ordered), so ordering by id approximates occurrence order.
    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        last_error text,
        constraint outbox_messages_attempts_non_negative check (attempts >= 0),
        constraint outbox_messages_scheduled_until_published check (published_at is not null or next_attempt_at is not null)
      )`);
    this.addSql(`
      create index outbox_messages_due
        on outbox_messages (next_attempt_at, id)
        where published_at is null`);
  }

  override down(): void {
    this.addSql('drop table outbox_messages');
    this.addSql('drop table inbox_messages');
    this.addSql('drop trigger wallets_balance_change_is_ledgered on wallets');
    this.addSql('drop function assert_balance_change_is_ledgered()');
    this.addSql('drop table wallet_ledger_entries');
    this.addSql('drop function forbid_ledger_mutation()');
    this.addSql('drop table wager_transactions');
    this.addSql('drop function guard_wager_transaction_change()');
    this.addSql('drop table wallets');
  }
}
