import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { insertLedger, insertTransaction, migrateUp, move, rawSql, seedWallet, uuid } from "./support/db";

/**
 * Proves the invariants of section 6 are enforced by PostgreSQL itself.
 * Every write here bypasses the application and goes straight to SQL.
 */
const db = rawSql();

beforeAll(async () => {
  await migrateUp();
});
afterAll(async () => {
  await db.close();
});

describe("wallets", () => {
  test("at most one wallet per player + currency", async () => {
    const { playerId } = await seedWallet(db, { balance: "0.00" });
    await expect(seedWallet(db, { playerId, balance: "0.00" })).rejects.toThrow(/wallets_player_currency_uq/);
    // same player, other currency is fine
    await expect(seedWallet(db, { playerId, currency: "USD", balance: "0.00" })).resolves.toBeDefined();
  });

  test("balance cannot be negative", async () => {
    await expect(seedWallet(db, { balance: "-0.01" })).rejects.toThrow(/wallets_balance_non_negative/);
  });

  test("balance cannot change without a matching ledger line (checked at commit)", async () => {
    const w = await seedWallet(db, { balance: "100.00" });
    await expect(
      db`UPDATE wallets SET balance_amount = 150.00, version = 2 WHERE id = ${w.walletId}`,
    ).rejects.toThrow(/does not match ledger balance/);
    const [row] = await db`SELECT balance_amount, version FROM wallets WHERE id = ${w.walletId}`;
    expect(row).toEqual({ balance_amount: "100.00", version: 1 });
  });

  test("a wallet cannot be opened with a balance that has no ledger line", async () => {
    await expect(
      db`INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
         VALUES (${uuid()}, ${"p-" + uuid()}, 'BRL', 10.00, 1, now(), now())`,
    ).rejects.toThrow(/does not match ledger balance/);
  });

  test("version must move by exactly +1 when the balance changes, and not otherwise", async () => {
    const w = await seedWallet(db, { balance: "100.00" });
    await expect(move(db, w, "DEBIT", "10.00", "100.00", "90.00", 3)).rejects.toThrow(/without incrementing version/);
    await expect(db`UPDATE wallets SET version = 5 WHERE id = ${w.walletId}`).rejects.toThrow(
      /version changed without a balance change/,
    );
    await expect(move(db, w, "DEBIT", "10.00", "100.00", "90.00", 2)).resolves.toBeDefined();
  });

  test("identity columns are immutable and wallets cannot be deleted", async () => {
    const w = await seedWallet(db, { balance: "0.00" });
    await expect(db`UPDATE wallets SET currency = 'USD' WHERE id = ${w.walletId}`).rejects.toThrow(/immutable/);
    await expect(db`DELETE FROM wallets WHERE id = ${w.walletId}`).rejects.toThrow(/cannot be deleted/);
  });
});

describe("ledger", () => {
  test("arithmetic must hold: before ± amount = after", async () => {
    const w = await seedWallet(db, { balance: "100.00" });
    const txId = await insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "BET", amount: "10.00" });
    await expect(
      insertLedger(db, { walletId: w.walletId, transactionId: txId, direction: "DEBIT", amount: "10.00", before: "100.00", after: "95.00" }),
    ).rejects.toThrow(/ledger_arithmetic/);
  });

  test("entries cannot leave a negative balance", async () => {
    const w = await seedWallet(db, { balance: "5.00" });
    const txId = await insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "BET", amount: "10.00" });
    await expect(
      insertLedger(db, { walletId: w.walletId, transactionId: txId, direction: "DEBIT", amount: "10.00", before: "5.00", after: "-5.00" }),
    ).rejects.toThrow(/ledger_balances_non_negative/);
  });

  test("entries must chain from the previous balance_after", async () => {
    const w = await seedWallet(db, { balance: "100.00" });
    const txId = await insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "WIN", amount: "10.00" });
    await expect(
      insertLedger(db, { walletId: w.walletId, transactionId: txId, direction: "CREDIT", amount: "10.00", before: "500.00", after: "510.00" }),
    ).rejects.toThrow(/ledger chain broken/);
  });

  test("entries must be in the wallet currency", async () => {
    const w = await seedWallet(db, { balance: "100.00" });
    const txId = await insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "WIN", amount: "10.00" });
    await expect(
      insertLedger(db, { walletId: w.walletId, transactionId: txId, direction: "CREDIT", amount: "10.00", before: "100.00", after: "110.00", currency: "USD" }),
    ).rejects.toThrow(/does not match wallet currency/);
  });

  test("one entry per transaction per wallet", async () => {
    const w = await seedWallet(db, { balance: "100.00" });
    await expect(
      insertLedger(db, { walletId: w.walletId, transactionId: w.openingTxId, direction: "CREDIT", amount: "1.00", before: "100.00", after: "101.00" }),
    ).rejects.toThrow(/ledger_one_entry_per_tx_per_wallet/);
  });

  test("is append-only: UPDATE, DELETE and TRUNCATE are refused", async () => {
    const w = await seedWallet(db, { balance: "100.00" });
    await expect(db`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ${w.walletId}`).rejects.toThrow(/append-only/);
    await expect(db`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${w.walletId}`).rejects.toThrow(/append-only/);
    await expect(db`TRUNCATE wallet_ledger_entries CASCADE`).rejects.toThrow(/append-only/);
  });

  test("wallet balance equals the balance rebuilt from the ledger after valid movements", async () => {
    const w = await seedWallet(db, { balance: "100.00" });
    await move(db, w, "DEBIT", "25.00", "100.00", "75.00", 2);
    await move(db, w, "CREDIT", "0.10", "75.00", "75.10", 3);
    await move(db, w, "CREDIT", "0.20", "75.10", "75.30", 4);
    const [row] = await db`
      SELECT w.balance_amount AS stored,
             SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END)::numeric(20,2)::text AS rebuilt
      FROM wallets w JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ${w.walletId} GROUP BY w.balance_amount`;
    expect(row).toEqual({ stored: "75.30", rebuilt: "75.30" });
  });
});

describe("wager_transactions", () => {
  test("idempotency key and (provider, external id) are unique", async () => {
    const w = await seedWallet(db, { balance: "100.00" });
    const ext = `ext-${uuid()}`;
    await insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "LOSS", amount: "0.00", externalId: ext });
    await expect(
      insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "LOSS", amount: "0.00", externalId: ext, idempotencyKey: `other-${uuid()}` }),
    ).rejects.toThrow(/wager_tx_provider_external_uq/);
    await expect(
      insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "LOSS", amount: "0.00", idempotencyKey: `provider-a:${ext}` }),
    ).rejects.toThrow(/wager_tx_idempotency_key_uq/);
  });

  test("amount rules: positive for balance-moving kinds, zero allowed only for LOSS", async () => {
    const w = await seedWallet(db, { balance: "100.00" });
    await expect(insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "BET", amount: "0.00" })).rejects.toThrow(
      /wager_tx_amount_valid/,
    );
    await expect(insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "LOSS", amount: "-1.00" })).rejects.toThrow(
      /wager_tx_amount_valid/,
    );
  });

  test("REFUND/ROLLBACK need a reference; processed reversals need it resolved", async () => {
    const w = await seedWallet(db, { balance: "100.00" });
    await expect(
      insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "REFUND", amount: "1.00", status: "PENDING_REFERENCE" }),
    ).rejects.toThrow(/wager_tx_reversal_has_reference/);
    await expect(
      insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "REFUND", amount: "1.00", referenceExternalId: "x" }),
    ).rejects.toThrow(/wager_tx_processed_reversal_resolved/);
  });

  test("status/failure code/processed_at are coherent", async () => {
    const w = await seedWallet(db, { balance: "100.00" });
    await expect(
      insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "BET", amount: "1.00", status: "REJECTED", failureCode: null as unknown as string }),
    ).resolves.toBeDefined(); // helper defaults a code for REJECTED
    await expect(
      insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "BET", amount: "1.00", status: "PROCESSED", failureCode: "INSUFFICIENT_FUNDS" }),
    ).rejects.toThrow(/wager_tx_failure_code_iff_failed/);
    await expect(
      insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "BET", amount: "1.00", status: "DONE" }),
    ).rejects.toThrow(/wager_tx_status_valid/);
  });

  test("a transaction can be reversed only once (REFUND or ROLLBACK)", async () => {
    const w = await seedWallet(db, { balance: "100.00" });
    const betId = await insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "BET", amount: "10.00" });
    const reversal = (kind: string) =>
      insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind, amount: "10.00", referenceExternalId: `ext-${betId}`, referenceTransactionId: betId });
    await reversal("REFUND");
    await expect(reversal("ROLLBACK")).rejects.toThrow(/wager_tx_single_reversal_uq/);
    await expect(reversal("REFUND")).rejects.toThrow(/wager_tx_single_reversal_uq/);
  });

  test("terminal transactions are frozen; business fields are always immutable; no deletes", async () => {
    const w = await seedWallet(db, { balance: "100.00" });
    const done = await insertTransaction(db, { walletId: w.walletId, playerId: w.playerId, kind: "LOSS", amount: "0.00" });
    await expect(db`UPDATE wager_transactions SET status = 'FAILED', failure_code = 'X' WHERE id = ${done}`).rejects.toThrow(
      /is terminal/,
    );
    const pending = await insertTransaction(db, {
      walletId: w.walletId, playerId: w.playerId, kind: "REFUND", amount: "1.00", status: "PENDING_REFERENCE", referenceExternalId: "later",
    });
    await expect(db`UPDATE wager_transactions SET amount = 2.00 WHERE id = ${pending}`).rejects.toThrow(/business fields are immutable/);
    await expect(db`UPDATE wager_transactions SET reference_attempts = 1, updated_at = now() WHERE id = ${pending}`).resolves.toBeDefined();
    await expect(db`DELETE FROM wager_transactions WHERE id = ${pending}`).rejects.toThrow(/cannot be deleted/);
    await expect(db`TRUNCATE wager_transactions CASCADE`).rejects.toThrow(/cannot be deleted/);
  });
});

describe("inbox / outbox", () => {
  test("inbox deduplicates by (consumer, messageId)", async () => {
    const id = `msg-${uuid()}`;
    const insert = () =>
      db`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES ('wager', ${id}, 'h', now())`;
    await insert();
    await expect(insert()).rejects.toThrow(/inbox_messages_pk/);
  });

  test("a pending outbox message must be scheduled", async () => {
    await expect(
      db`INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
         VALUES (${uuid()}, 'a', 'E', '{}'::jsonb, now())`,
    ).rejects.toThrow(/outbox_pending_is_scheduled/);
  });
});
