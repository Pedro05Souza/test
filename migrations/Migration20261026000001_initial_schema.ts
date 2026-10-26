import { Migration } from "@mikro-orm/migrations";

/**
 * Initial schema. Every financial invariant is enforced here, independently of application code:
 * uniqueness (idempotency, one wallet per player+currency, one reversal per reference),
 * non-negativity, ledger arithmetic and chaining, ledger immutability, terminal-state immutability,
 * and wallet ↔ ledger consistency (checked at commit).
 */
export class Migration20261026000001InitialSchema extends Migration {
  override name = "Migration20261026000001_initial_schema";

  override up(): void {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      CREATE TABLE wallets (
        id              uuid           PRIMARY KEY,
        player_id       varchar(128)   NOT NULL,
        currency        char(3)        NOT NULL,
        balance_amount  numeric(20,2)  NOT NULL,
        version         integer        NOT NULL,
        created_at      timestamptz    NOT NULL,
        updated_at      timestamptz    NOT NULL,
        CONSTRAINT wallets_player_currency_uq   UNIQUE (player_id, currency),
        CONSTRAINT wallets_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT wallets_version_positive     CHECK (version >= 1),
        CONSTRAINT wallets_currency_iso         CHECK (currency ~ '^[A-Z]{3}$')
      )`);

    // ---------------------------------------------------------------- wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid           PRIMARY KEY,
        provider_id                        varchar(64)    NOT NULL,
        external_transaction_id            varchar(128)   NOT NULL,
        idempotency_key                    varchar(256)   NOT NULL,
        payload_hash                       varchar(64)    NOT NULL,
        wallet_id                          uuid           NOT NULL REFERENCES wallets(id),
        player_id                          varchar(128)   NOT NULL,
        round_id                           varchar(128)   NOT NULL,
        game_id                            varchar(128)   NOT NULL,
        kind                               varchar(16)    NOT NULL,
        amount                             numeric(20,2)  NOT NULL,
        currency                           char(3)        NOT NULL,
        reference_external_transaction_id  varchar(128),
        reference_transaction_id           uuid           REFERENCES wager_transactions(id),
        status                             varchar(20)    NOT NULL,
        failure_code                       varchar(40),
        result_balance_amount              numeric(20,2),
        reference_attempts                 integer        NOT NULL DEFAULT 0,
        next_reference_check_at            timestamptz,
        created_at                         timestamptz    NOT NULL,
        processed_at                       timestamptz,
        updated_at                         timestamptz    NOT NULL,
        CONSTRAINT wager_tx_idempotency_key_uq UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_tx_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_tx_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
        -- LOSS may carry 0.00; every balance-moving kind must be positive
        CONSTRAINT wager_tx_amount_valid CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
        CONSTRAINT wager_tx_reversal_has_reference
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_processed_reversal_resolved
          CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_failure_code_iff_failed
          CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_tx_processed_at_iff_terminal
          CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL)),
        CONSTRAINT wager_tx_pending_reference_scheduled
          CHECK (status <> 'PENDING_REFERENCE' OR next_reference_check_at IS NOT NULL),
        CONSTRAINT wager_tx_result_balance_non_negative CHECK (result_balance_amount >= 0),
        CONSTRAINT wager_tx_reference_attempts_non_negative CHECK (reference_attempts >= 0)
      )`);

    // A transaction can be reverted only once (by REFUND or ROLLBACK, whichever is processed first).
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`);
    // Reference resolution and the PENDING_REFERENCE worker.
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due_idx
        ON wager_transactions (next_reference_check_at)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
      CREATE INDEX wager_tx_waiting_on_reference_idx
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id)`);

    // ---------------------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        seq             bigint         GENERATED ALWAYS AS IDENTITY,
        id              uuid           PRIMARY KEY,
        wallet_id       uuid           NOT NULL REFERENCES wallets(id),
        transaction_id  uuid           NOT NULL REFERENCES wager_transactions(id),
        direction       varchar(6)     NOT NULL,
        amount          numeric(20,2)  NOT NULL,
        currency        char(3)        NOT NULL,
        balance_before  numeric(20,2)  NOT NULL,
        balance_after   numeric(20,2)  NOT NULL,
        created_at      timestamptz    NOT NULL,
        CONSTRAINT ledger_seq_uq UNIQUE (seq),
        CONSTRAINT ledger_one_entry_per_tx_per_wallet UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ledger_arithmetic CHECK (
          balance_after = CASE direction WHEN 'CREDIT' THEN balance_before + amount
                                         ELSE balance_before - amount END)
      )`);
    this.addSql(`CREATE INDEX ledger_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq)`);

    // Append-only: no UPDATE, DELETE or TRUNCATE, ever.
    this.addSql(`
      CREATE FUNCTION ledger_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% forbidden)', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$`);
    this.addSql(`
      CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation()`);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_mutation()`);

    // Chain: each entry continues from the wallet's previous entry, in the wallet's currency.
    // The wallet row lock serializes concurrent inserts for the same wallet.
    this.addSql(`
      CREATE FUNCTION ledger_check_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        wallet_currency char(3);
        previous_after  numeric(20,2);
      BEGIN
        SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id FOR UPDATE;
        IF wallet_currency IS DISTINCT FROM NEW.currency THEN
          RAISE EXCEPTION 'ledger entry currency % does not match wallet currency %', NEW.currency, wallet_currency
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT balance_after INTO previous_after FROM wallet_ledger_entries
          WHERE wallet_id = NEW.wallet_id ORDER BY seq DESC LIMIT 1;
        IF NEW.balance_before <> COALESCE(previous_after, 0) THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: balance_before % <> previous balance_after %',
            NEW.wallet_id, NEW.balance_before, COALESCE(previous_after, 0)
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER ledger_chain BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_check_chain()`);

    // ---------------------------------------------------------------- wallet guards
    // Identity columns are immutable; version moves by exactly +1 iff the balance changes; no deletes.
    this.addSql(`
      CREATE FUNCTION wallets_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet identity columns are immutable' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.balance_amount <> OLD.balance_amount AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'wallet % balance changed without incrementing version by 1', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.balance_amount = OLD.balance_amount AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet % version changed without a balance change', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wallets_guard BEFORE UPDATE OR DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallets_guard_update()`);

    // Wallet ↔ ledger consistency, verified at COMMIT (deferred), so statement order inside the
    // transaction does not matter: the stored balance must equal the latest ledger balance_after
    // (or 0 when the wallet has no entries).
    this.addSql(`
      CREATE FUNCTION wallets_check_ledger_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        stored  numeric(20,2);
        latest  numeric(20,2);
      BEGIN
        SELECT balance_amount INTO stored FROM wallets WHERE id = NEW.id;
        SELECT balance_after INTO latest FROM wallet_ledger_entries
          WHERE wallet_id = NEW.id ORDER BY seq DESC LIMIT 1;
        IF stored <> COALESCE(latest, 0) THEN
          RAISE EXCEPTION 'wallet % balance % does not match ledger balance %', NEW.id, stored, COALESCE(latest, 0)
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallets_check_ledger_consistency()`);

    // ---------------------------------------------------------------- wager transaction guards
    // Business fields never change; terminal rows never change; nothing is ever deleted.
    this.addSql(`
      CREATE FUNCTION wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP <> 'UPDATE' THEN
          RAISE EXCEPTION 'wager_transactions cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'wager transaction % business fields are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_tx_guard()`);
    this.addSql(`
      CREATE TRIGGER wager_tx_no_truncate BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION wager_tx_guard()`);

    // ---------------------------------------------------------------- inbox / outbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  varchar(64)   NOT NULL,
        message_id     varchar(128)  NOT NULL,
        payload_hash   varchar(64)   NOT NULL,
        received_at    timestamptz   NOT NULL,
        processed_at   timestamptz,
        CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid          PRIMARY KEY,
        aggregate_id     varchar(128)  NOT NULL,
        event_type       varchar(64)   NOT NULL,
        payload          jsonb         NOT NULL,
        occurred_at      timestamptz   NOT NULL,
        attempts         integer       NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        last_error       varchar(500),
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0),
        CONSTRAINT outbox_pending_is_scheduled CHECK (published_at IS NOT NULL OR next_attempt_at IS NOT NULL)
      )`);
    this.addSql(`
      CREATE INDEX outbox_pending_due_idx ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL`);
  }

  override down(): void {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
    this.addSql(`DROP TABLE IF EXISTS wallets`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_tx_guard()`);
    this.addSql(`DROP FUNCTION IF EXISTS wallets_check_ledger_consistency()`);
    this.addSql(`DROP FUNCTION IF EXISTS wallets_guard_update()`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_check_chain()`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_forbid_mutation()`);
  }
}
