import { MikroORM } from "@mikro-orm/postgresql";
import { SQL } from "bun";
import {
  createOrmConfig,
  DEFAULT_DATABASE_URL,
} from "../../../src/shared/infrastructure/database/mikro-orm.config";

export const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

/** Raw client used to probe the schema directly, bypassing all application code. */
export function rawSql(url = DATABASE_URL): SQL {
  return new SQL(url, { max: 10 });
}

/** Applies pending migrations (idempotent). Tests never truncate: every test uses fresh ids. */
export async function migrateUp(url = DATABASE_URL): Promise<void> {
  const orm = await MikroORM.init(createOrmConfig({ clientUrl: url }));
  try {
    await orm.migrator.up();
  } finally {
    await orm.close(true);
  }
}

export const uuid = () => Bun.randomUUIDv7();

type Tx = SQL;

/** Inserts a wallet funded through an OPENING transaction + CREDIT ledger line, as the app does. */
export async function seedWallet(
  db: Tx,
  opts: { balance?: string; currency?: string; playerId?: string } = {},
): Promise<{ walletId: string; playerId: string; openingTxId: string }> {
  const walletId = uuid();
  const openingTxId = uuid();
  const playerId = opts.playerId ?? `player-${uuid()}`;
  const currency = opts.currency ?? "BRL";
  const balance = opts.balance ?? "100.00";
  await db.begin(async (tx) => {
    await tx`INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
             VALUES (${walletId}, ${playerId}, ${currency}, ${balance}, 1, now(), now())`;
    if (balance !== "0.00") {
      await insertTransaction(tx, {
        id: openingTxId,
        walletId,
        playerId,
        kind: "OPENING",
        amount: balance,
        currency,
        status: "PROCESSED",
        providerId: "internal",
        externalId: `opening:${walletId}`,
      });
      await insertLedger(tx, {
        walletId,
        transactionId: openingTxId,
        direction: "CREDIT",
        amount: balance,
        before: "0.00",
        after: balance,
        currency,
      });
    }
  });
  return { walletId, playerId, openingTxId };
}

export interface TxRow {
  id?: string;
  walletId: string;
  playerId: string;
  kind: string;
  amount: string;
  currency?: string;
  status?: string;
  providerId?: string;
  externalId?: string;
  idempotencyKey?: string;
  referenceExternalId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
}

export async function insertTransaction(db: Tx, row: TxRow): Promise<string> {
  const id = row.id ?? uuid();
  const providerId = row.providerId ?? "provider-a";
  const externalId = row.externalId ?? `ext-${id}`;
  const status = row.status ?? "PROCESSED";
  const terminal = ["PROCESSED", "REJECTED", "FAILED"].includes(status);
  await db`
    INSERT INTO wager_transactions (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
      round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
      status, failure_code, result_balance_amount, reference_attempts, next_reference_check_at,
      created_at, processed_at, updated_at)
    VALUES (
      ${id}, ${providerId}, ${externalId}, ${row.idempotencyKey ?? `${providerId}:${externalId}`}, ${"h".repeat(64)},
      ${row.walletId}, ${row.playerId}, ${"round-1"}, ${"game-1"}, ${row.kind}, ${row.amount}, ${row.currency ?? "BRL"},
      ${row.referenceExternalId ?? null}, ${row.referenceTransactionId ?? null}, ${status},
      ${row.failureCode ?? (status === "REJECTED" || status === "FAILED" ? "INSUFFICIENT_FUNDS" : null)},
      ${terminal && status !== "FAILED" ? "0.00" : null}, 0,
      ${status === "PENDING_REFERENCE" ? new Date() : null},
      now(), ${terminal ? new Date() : null}, now())`;
  return id;
}

export async function insertLedger(
  db: Tx,
  row: {
    walletId: string;
    transactionId: string;
    direction: "DEBIT" | "CREDIT";
    amount: string;
    before: string;
    after: string;
    currency?: string;
  },
): Promise<string> {
  const id = uuid();
  await db`
    INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                                       balance_before, balance_after, created_at)
    VALUES (${id}, ${row.walletId}, ${row.transactionId}, ${row.direction}, ${row.amount}, ${row.currency ?? "BRL"},
            ${row.before}, ${row.after}, now())`;
  return id;
}

/** Applies a debit/credit exactly as a correct application would (wallet update + ledger line). */
export async function move(
  db: Tx,
  w: { walletId: string; playerId: string },
  direction: "DEBIT" | "CREDIT",
  amount: string,
  before: string,
  after: string,
  version: number,
): Promise<string> {
  let txId = "";
  await db.begin(async (tx) => {
    txId = await insertTransaction(tx, { walletId: w.walletId, playerId: w.playerId, kind: direction === "DEBIT" ? "BET" : "WIN", amount });
    await tx`UPDATE wallets SET balance_amount = ${after}, version = ${version}, updated_at = now() WHERE id = ${w.walletId}`;
    await insertLedger(tx, { walletId: w.walletId, transactionId: txId, direction, amount, before, after });
  });
  return txId;
}
