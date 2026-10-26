import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startApp, type RunningApp } from "../support/app";
import { Api, db, ledgerInvariant, wager } from "../support/api";

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

describe("POST /wallets", () => {
  test("opens a wallet with version 1, an OPENING credit and a WalletBalanceChanged event, atomically", async () => {
    const res = await api.openWallet("1000.00");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ balance: { amount: "1000.00", currency: "BRL" }, version: 1 });

    const ledger = await api.request("GET", `/wallets/${res.body.id}/ledger`);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({ direction: "CREDIT", balanceBefore: { amount: "0.00" }, balanceAfter: { amount: "1000.00" } });

    const [opening] = await sql`SELECT kind, status FROM wager_transactions WHERE wallet_id = ${res.body.id}`;
    expect(opening).toEqual({ kind: "OPENING", status: "PROCESSED" });
    const events = await sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${res.body.id}`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(["WalletBalanceChanged"]);
  });

  test("zero initial balance creates no ledger line", async () => {
    const res = await api.openWallet("0.00");
    expect(res.status).toBe(201);
    expect((await ledgerInvariant(sql, res.body.id)).entries).toBe(0);
  });

  test("duplicate player + currency → 409, other currency is fine", async () => {
    const playerId = `player-${Bun.randomUUIDv7()}`;
    expect((await api.openWallet("1.00", "BRL", playerId)).status).toBe(201);
    const dup = await api.openWallet("1.00", "BRL", playerId);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("WALLET_ALREADY_EXISTS");
    expect((await api.openWallet("1.00", "USD", playerId)).status).toBe(201);
  });

  test.each([
    ["number amount", { playerId: "p", initialBalance: { amount: 10, currency: "BRL" } }],
    ["3 decimals", { playerId: "p", initialBalance: { amount: "1.001", currency: "BRL" } }],
    ["negative", { playerId: "p", initialBalance: { amount: "-1.00", currency: "BRL" } }],
    ["unknown field", { playerId: "p", initialBalance: { amount: "1.00", currency: "BRL" }, extra: 1 }],
    ["missing playerId", { initialBalance: { amount: "1.00", currency: "BRL" } }],
  ])("invalid payload (%s) → 400", async (_label, body) => {
    const res = await api.request("POST", "/wallets", body);
    expect(res.status).toBe(400);
    expect(res.body.error.retryable).toBe(false);
  });

  test("malformed JSON → 400", async () => {
    const res = await api.request("POST", "/wallets", "{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PAYLOAD");
  });
});

describe("GET /wallets", () => {
  test("unknown or malformed wallet ids", async () => {
    expect((await api.request("GET", `/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await api.request("GET", "/wallets/not-a-uuid")).status).toBe(400);
  });

  test("ledger pagination with a stable opaque cursor", async () => {
    const w = await api.wallet("100.00");
    for (let i = 0; i < 5; i++) expect((await api.submit(wager(w, "BET", "1.00"))).status).toBe(201);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.request("GET", `/wallets/${w.id}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.items.map((i: { id: string }) => i.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);

    expect((await api.request("GET", `/wallets/${w.id}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await api.request("GET", `/wallets/${w.id}/ledger?limit=0`)).status).toBe(400);
    expect((await api.request("GET", `/wallets/${w.id}/ledger?limit=201`)).status).toBe(400);
  });
});

describe("POST /wagering/transactions", () => {
  test("BET → 201 with the new balance; identical retry → 200 replay with the original result", async () => {
    const w = await api.wallet("100.00");
    const payload = wager(w, "BET", "25.00");
    const first = await api.submit(payload);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: "PROCESSED", balance: { amount: "75.00", currency: "BRL" }, idempotentReplay: false });

    await api.submit(wager(w, "BET", "5.00")); // balance moves on…
    const replay = await api.submit(payload); // …but the replay returns the balance observed back then
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await ledgerInvariant(sql, w.id)).toMatchObject({ stored: "70.00", rebuilt: "70.00", debits: 2 });
  });

  test("same key with a different payload → 409, never a replay", async () => {
    const w = await api.wallet("100.00");
    const payload = wager(w, "BET", "25.00");
    await api.submit(payload);
    const conflict = await api.submit({ ...payload, money: { amount: "26.00", currency: "BRL" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    // same external id under another key is also a conflict
    const otherKey = await api.submit(payload, `another-key-${Bun.randomUUIDv7()}`);
    expect(otherKey.status).toBe(409);
    expect((await ledgerInvariant(sql, w.id)).debits).toBe(1);
  });

  test("insufficient funds → 422 with failureCode; replay returns the same 422", async () => {
    const w = await api.wallet("10.00");
    const payload = wager(w, "BET", "10.01");
    const res = await api.submit(payload);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", providerAction: "DO_NOT_RETRY", balance: { amount: "10.00" } });
    const replay = await api.submit(payload);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...res.body, idempotentReplay: true });
    expect(await ledgerInvariant(sql, w.id)).toMatchObject({ stored: "10.00", entries: 1 });
  });

  test("full round: BET, WIN, LOSS, REFUND, ROLLBACK", async () => {
    const w = await api.wallet("100.00");
    const bet = wager(w, "BET", "30.00");
    expect((await api.submit(bet)).body.balance.amount).toBe("70.00");
    const win = wager(w, "WIN", "50.00", { referenceExternalTransactionId: bet.externalTransactionId });
    expect((await api.submit(win)).body.balance.amount).toBe("120.00");
    const loss = await api.submit(wager(w, "LOSS", "0.00"));
    expect(loss.status).toBe(201);
    expect(loss.body.balance.amount).toBe("120.00");

    const rollbackWin = await api.submit(wager(w, "ROLLBACK", "50.00", { referenceExternalTransactionId: win.externalTransactionId }));
    expect(rollbackWin.body).toMatchObject({ status: "PROCESSED", balance: { amount: "70.00" } });
    const refund = await api.submit(wager(w, "REFUND", "30.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund.body).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });

    const again = await api.submit(wager(w, "ROLLBACK", "30.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(again.status).toBe(422);
    expect(again.body.failureCode).toBe("ALREADY_REVERSED");

    // LOSS: no ledger line. OPENING + BET + WIN + ROLLBACK + REFUND = 5 lines
    expect(await ledgerInvariant(sql, w.id)).toMatchObject({ stored: "100.00", rebuilt: "100.00", entries: 5 });
  });

  test("events are written to the outbox in the same transaction (one per outcome)", async () => {
    const w = await api.wallet("100.00");
    const ok = await api.submit(wager(w, "BET", "1.00"));
    const rejected = await api.submit(wager(w, "BET", "1000.00"));
    const pending = await api.submit(wager(w, "REFUND", "1.00", { referenceExternalTransactionId: "never" }));
    const types = async (id: string) =>
      (await sql`SELECT event_type FROM outbox_messages WHERE aggregate_id IN (${id}, ${w.id}) AND payload->'data'->>'transactionId' = ${id} ORDER BY event_type`).map(
        (r: { event_type: string }) => r.event_type,
      );
    expect(await types(ok.body.transactionId)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    expect(await types(rejected.body.transactionId)).toEqual(["WagerTransactionRejected"]);
    expect(await types(pending.body.transactionId)).toEqual(["WagerTransactionPendingReference"]);
  });

  test("REFUND before its BET → 202 PENDING_REFERENCE", async () => {
    const w = await api.wallet("100.00");
    const res = await api.submit(wager(w, "REFUND", "10.00", { referenceExternalTransactionId: "bet-not-yet" }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "PENDING_REFERENCE", balance: { amount: "100.00" } });
  });

  test("currency mismatch and foreign player are persisted rejections (422)", async () => {
    const w = await api.wallet("100.00");
    const usd = await api.submit(wager(w, "BET", "1.00", { money: { amount: "1.00", currency: "USD" } }));
    expect(usd.status).toBe(422);
    expect(usd.body.failureCode).toBe("CURRENCY_MISMATCH");
    const stranger = await api.submit(wager(w, "BET", "1.00", { playerId: "someone-else" }));
    expect(stranger.status).toBe(422);
    expect(stranger.body.failureCode).toBe("WALLET_PLAYER_MISMATCH");
  });

  test.each([
    ["missing Idempotency-Key", (p: object) => api.request("POST", "/wagering/transactions", p)],
    ["OPENING kind", (p: object) => api.submit({ ...(p as any), kind: "OPENING" })],
    ["REFUND without reference", (p: object) => api.submit({ ...(p as any), kind: "REFUND" })],
    ["zero BET", (p: object) => api.submit({ ...(p as any), money: { amount: "0.00", currency: "BRL" } })],
    ["scientific notation", (p: object) => api.submit({ ...(p as any), money: { amount: "1e2", currency: "BRL" } })],
    ["invalid walletId", (p: object) => api.submit({ ...(p as any), walletId: "x" })],
  ])("invalid request (%s) → 400", async (_label, send) => {
    const w = await api.wallet("100.00");
    const res = await send(wager(w, "BET", "1.00"));
    expect(res.status).toBe(400);
    expect(await ledgerInvariant(sql, w.id)).toMatchObject({ entries: 1 });
  });

  test("unknown wallet → 404", async () => {
    const res = await api.submit(wager({ id: Bun.randomUUIDv7(), playerId: "p" }, "BET", "1.00"));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("WALLET_NOT_FOUND");
  });
});

describe("transaction lookups", () => {
  test("by internal id and by provider external id", async () => {
    const w = await api.wallet("100.00");
    const payload = wager(w, "BET", "12.34");
    const { body } = await api.submit(payload);

    const byId = await api.request("GET", `/wagering/transactions/${body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ id: body.transactionId, kind: "BET", status: "PROCESSED", money: { amount: "12.34" }, resultBalance: { amount: "87.66" } });

    const byExt = await api.request("GET", `/providers/provider-a/wagering/transactions/${payload.externalTransactionId}`);
    expect(byExt.body).toEqual(byId.body);
    expect((await api.request("GET", `/providers/provider-b/wagering/transactions/${payload.externalTransactionId}`)).status).toBe(404);
    expect((await api.request("GET", `/wagering/transactions/${Bun.randomUUIDv7()}`)).status).toBe(404);
  });
});

describe("POST /wallets/:id/reconciliation", () => {
  test("consistent wallet", async () => {
    const w = await api.wallet("100.00");
    await api.submit(wager(w, "BET", "24.50"));
    const res = await api.request("POST", `/wallets/${w.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: w.id,
      storedBalance: { amount: "75.50", currency: "BRL" },
      calculatedBalance: { amount: "75.50", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test("divergence is reported and counted, never silently fixed", async () => {
    const w = await api.wallet("100.00");
    // Simulate corruption by bypassing every trigger (superuser-only), as a buggy migration might.
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE wallets SET balance_amount = 90.00 WHERE id = ${w.id}`;
    });
    const res = await api.request("POST", `/wallets/${w.id}/reconciliation`);
    expect(res.body).toMatchObject({ consistent: false, difference: { amount: "-10.00" }, storedBalance: { amount: "90.00" }, calculatedBalance: { amount: "100.00" } });
    const [row] = await sql`SELECT balance_amount::text AS b FROM wallets WHERE id = ${w.id}`;
    expect(row.b).toBe("90.00"); // untouched
    const metrics = await fetch(`${running.baseUrl}/metrics`).then((r) => r.text());
    expect(metrics).toMatch(/wagering_reconciliations_total\{result="divergent"\} [1-9]/);
  });
});

describe("metrics", () => {
  test("exposes every metric required by section 12", async () => {
    const w = await api.wallet("100.00");
    await api.submit(wager(w, "BET", "1.00"));
    const text = await fetch(`${running.baseUrl}/metrics`).then((r) => r.text());
    for (const name of [
      "wagering_transactions_total", // transactions by status
      "wagering_duplicates_detected_total", // duplicates
      "wagering_retries_total", // retries
      "wagering_dlq_messages_total", // DLQ
      "wagering_lock_conflicts_total", // lock conflicts
      "wagering_outbox_lag_seconds", // outbox lag
      "wagering_processing_duration_seconds", // latency
    ]) {
      expect(text).toContain(`# TYPE ${name}`);
    }
    expect(text).toMatch(/wagering_transactions_total\{status="PROCESSED",kind="BET",source="http"\} \d+/);
    expect(text).toMatch(/wagering_processing_duration_seconds_bucket\{le="0.05",source="http"\} \d+/);
  });

  test("responses carry the correlation id (echoed or generated)", async () => {
    const res = await fetch(`${running.baseUrl}/health/live`, { headers: { "x-correlation-id": "abc-123" } });
    expect(res.headers.get("x-correlation-id")).toBe("abc-123");
    const generated = await fetch(`${running.baseUrl}/health/live`);
    expect(generated.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("health", () => {
  test("liveness and readiness are open and report dependencies", async () => {
    expect((await api.request("GET", "/health/live")).body).toEqual({ status: "ok" });
    const ready = await api.request("GET", "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: { status: "up" }, sqs: { status: "up" } });
  });
});
