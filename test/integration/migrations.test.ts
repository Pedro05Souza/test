import { afterAll, beforeAll, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "../../src/shared/infrastructure/database/mikro-orm.config";
import { DATABASE_URL, rawSql } from "./support/db";

/** Runs on a throwaway database so reverting migrations never disturbs other suites. */
const dbName = `wagering_migrations_${Date.now()}`;
const admin = rawSql();
const url = DATABASE_URL.replace(/\/[^/]+$/, `/${dbName}`);

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
});
afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.close();
});

const APP_TABLES = ["inbox_messages", "outbox_messages", "wager_transactions", "wallet_ledger_entries", "wallets"];

async function tables(): Promise<string[]> {
  const db = rawSql(url);
  try {
    const rows = await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations' ORDER BY 1`;
    return rows.map((r: { tablename: string }) => r.tablename);
  } finally {
    await db.close();
  }
}

test("migrations apply, revert completely and re-apply", async () => {
  const orm = await MikroORM.init(createOrmConfig({ clientUrl: url }));
  try {
    expect((await orm.migrator.up()).length).toBe(1);
    expect(await tables()).toEqual(APP_TABLES);
    expect(await orm.migrator.getPending()).toEqual([]);

    await orm.migrator.down();
    expect(await tables()).toEqual([]);

    await orm.migrator.up();
    expect(await tables()).toEqual(APP_TABLES);
  } finally {
    await orm.close(true);
  }
});
