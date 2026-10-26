import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startApp, type RunningApp } from "../support/app";
import { Api, db, ledgerInvariant, wager } from "../support/api";

/**
 * Real parallelism: requests are fired concurrently over HTTP and each runs in its own Postgres
 * transaction on its own pooled connection. No mocks, no sequential simulation.
 */
let running: RunningApp;
let api: Api;
const sql = db();

beforeAll(async () => {
  running = await startApp();
  api = new Api(running.baseUrl);
});
afterAll(async () => {
  await running.close();
  await sql.close();
});

describe("section 8 — two 80.00 bets racing for 100.00", () => {
  test("exactly one PROCESSED, one REJECTED(INSUFFICIENT_FUNDS), balance 20.00, one debit (20 rounds)", async () => {
    for (let round = 0; round < 20; round++) {
      const w = await api.wallet("100.00");
      const betA = wager(w, "BET", "80.00");
      const betB = wager(w, "BET", "80.00");
      const [a, b] = await Promise.all([api.submit(betA), api.submit(betB)]);

      const statuses = [a.body.status, b.body.status].sort();
      expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
      expect([a, b].find((r) => r.body.status === "REJECTED")!.body.failureCode).toBe("INSUFFICIENT_FUNDS");

      // retrying both (in parallel, twice) replays the original outcomes and never debits again
      const retries = await Promise.all([api.submit(betA), api.submit(betB), api.submit(betA), api.submit(betB)]);
      expect(retries.every((r) => r.body.idempotentReplay === true)).toBe(true);
      expect(retries[0]!.body).toEqual({ ...a.body, idempotentReplay: true });
      expect(retries[1]!.body).toEqual({ ...b.body, idempotentReplay: true });

      expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "20.00", rebuilt: "20.00", entries: 2, debits: 1 });
    }
  });
});

describe("idempotency under parallel duplicates", () => {
  test("the same BET sent 50 times in parallel debits exactly once", async () => {
    const w = await api.wallet("100.00");
    const payload = wager(w, "BET", "10.00");
    const results = await Promise.all(Array.from({ length: 50 }, () => api.submit(payload)));

    expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.body.balance.amount === "90.00")).toBe(true);
    expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "90.00", rebuilt: "90.00", entries: 2, debits: 1 });
  });

  test("50 parallel duplicates mixed with 50 conflicting payloads: one debit, conflicts never applied", async () => {
    const w = await api.wallet("100.00");
    const payload = wager(w, "BET", "10.00");
    const conflicting = { ...payload, money: { amount: "11.00", currency: "BRL" } };
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => api.submit(i % 2 === 0 ? payload : conflicting)),
    );
    const applied = results.filter((r) => r.status === 201);
    expect(applied).toHaveLength(1);
    // whichever payload won, every request with the other payload is a 409
    const winner = applied[0]!.body.balance.amount === "90.00" ? "10.00" : "11.00";
    expect(results.filter((r) => r.status === 409)).toHaveLength(50);
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    const inv = await ledgerInvariant(sql, w.id);
    expect(inv.debits).toBe(1);
    expect(inv.stored).toBe(winner === "10.00" ? "90.00" : "89.00");
    expect(inv.stored).toBe(inv.rebuilt);
  });
});

describe("hot wallet", () => {
  test("100 parallel 1.00 bets on 50.00: exactly 50 processed, balance never negative", async () => {
    const w = await api.wallet("50.00");
    const results = await Promise.all(Array.from({ length: 100 }, () => api.submit(wager(w, "BET", "1.00"))));
    expect(results.filter((r) => r.body.status === "PROCESSED")).toHaveLength(50);
    expect(results.filter((r) => r.body.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(50);
    expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "0.00", rebuilt: "0.00", entries: 51, debits: 50 });
    const [{ version }] = await sql`SELECT version FROM wallets WHERE id = ${w.id}`;
    expect(version).toBe(51); // +1 per balance change, never for rejections
  });

  test("parallel BETs and WINs on one wallet commute to the exact final balance", async () => {
    const w = await api.wallet("100.00");
    const ops = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? wager(w, "BET", "1.25") : wager(w, "WIN", "0.75")));
    const results = await Promise.all(ops.map((op) => api.submit(op)));
    expect(results.every((r) => r.body.status === "PROCESSED")).toBe(true);
    // 100 − 30×1.25 + 30×0.75 = 85.00
    expect(await ledgerInvariant(sql, w.id)).toMatchObject({ stored: "85.00", rebuilt: "85.00", entries: 61 });
  });
});

describe("independent wallets", () => {
  test("20 wallets × 10 bets in parallel: every wallet ends exact and consistent", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => api.wallet("100.00")));
    const started = performance.now();
    const results = await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 10 }, () => api.submit(wager(w, "BET", "7.50")))),
    );
    const elapsed = performance.now() - started;
    expect(results.every((r) => r.status === 201)).toBe(true);
    for (const w of wallets) {
      expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "25.00", rebuilt: "25.00", entries: 11, debits: 10 });
    }
    // sanity: no global serialization (200 requests would take far longer if wallets blocked each other)
    expect(elapsed).toBeLessThan(15_000);
  });
});
