import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, type Options } from "@mikro-orm/postgresql";
import { Migration20261026000001InitialSchema } from "../../../../migrations/Migration20261026000001_initial_schema";
import { InboxMessageRecord, OutboxMessageRecord } from "../../../messaging/infrastructure/messaging.records";
import { WagerTransactionRecord } from "../../../wagering/infrastructure/wager-transaction.record";
import { WalletLedgerEntryRecord } from "../../../wallet/infrastructure/wallet-ledger-entry.record";
import { WalletRecord } from "../../../wallet/infrastructure/wallet.record";

export const DEFAULT_DATABASE_URL = "postgres://wagering:wagering@localhost:5432/wagering";

/** Migrations are listed explicitly (no filesystem globbing) so the same list works under Bun, tests and Docker. */
export const MIGRATIONS = [Migration20261026000001InitialSchema];

export function createOrmConfig(overrides: Partial<Options> = {}): Options {
  return defineConfig({
    clientUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    entities: [WalletRecord, WalletLedgerEntryRecord, WagerTransactionRecord, InboxMessageRecord, OutboxMessageRecord],
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: "mikro_orm_migrations",
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    pool: { min: 0, max: Number(process.env.DB_POOL_MAX ?? 20) },
    // The schema is owned by hand-written migrations; never let the ORM alter it implicitly.
    ensureDatabase: false,
    debug: process.env.ORM_DEBUG === "true",
    ...overrides,
  });
}
