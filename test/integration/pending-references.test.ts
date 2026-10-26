import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ResolvePendingReferences } from "../../src/wagering/application/resolve-pending-references";
import { Api, db, ledgerInvariant, wager } from "../support/api";
import { startApp, type RunningApp } from "../support/app";
import { waitFor } from "../support/queues";

/** Out-of-order references (section 7.1). Fast policy: 3 attempts, 50ms · 2^n backoff (max 200ms). */
let running: RunningApp;
let api: Api;
let resolver: ResolvePendingReferences;
const sql = db();

beforeAll(async () => {
  running = await startApp({
    env: { REFERENCE_MAX_ATTEMPTS: "3", REFERENCE_BASE_DELAY_MS: "50", REFERENCE_MAX_DELAY_MS: "200" },
  });
  api = new Api(running.baseUrl);
  resolver = running.app.get(ResolvePendingReferences);
});
afterAll(async () => {
  await running.close();
  await sql.close();
});

const txRow = async (id: string) =>
  (await sql`SELECT status, failure_code, reference_attempts, reference_transaction_id FROM wager_transactions WHERE id = ${id}`)[0];
const eventsOf = async (transactionId: string) =>
  (
    await sql`SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ${transactionId} ORDER BY occurred_at, event_type`
  ).map((r: { event_type: string }) => r.event_type);

/** Runs the worker until `transactionId` is terminal. */
async function resolveUntilTerminal(transactionId: string) {
  return waitFor(async () => {
    await resolver.runOnce(500);
    const row = await txRow(transactionId);
    return row.status !== "PENDING_REFERENCE" ? row : undefined;
  }, 10_000, 60);
}

describe("REFUND/ROLLBACK delivered before the reference", () => {
  test("REFUND before its BET: PENDING_REFERENCE, then PROCESSED once the BET arrives", async () => {
    const w = await api.wallet("100.00");
    const bet = wager(w, "BET", "40.00");
    const refundPayload = wager(w, "REFUND", "40.00", { referenceExternalTransactionId: bet.externalTransactionId });
    const refund = await api.submit(refundPayload);
    expect(refund.status).toBe(202);

    expect((await api.submit(bet)).status).toBe(201); // wakes the waiting REFUND
    const row = await resolveUntilTerminal(refund.body.transactionId);
    expect(row).toMatchObject({ status: "PROCESSED", failure_code: null });
    expect(row.reference_transaction_id).toBeTruthy();

    expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "100.00", rebuilt: "100.00", entries: 3, debits: 1 });
    // announced once while waiting, then the final outcome
    expect(await eventsOf(refund.body.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    // replaying the original REFUND request now returns its final outcome
    const replay = await api.submit(refundPayload);
    expect(replay.body).toMatchObject({ status: "PROCESSED", idempotentReplay: true, balance: { amount: "100.00" } });
  });

  test("ROLLBACK of a WIN before the WIN: debits once the WIN is applied", async () => {
    const w = await api.wallet("10.00");
    const win = wager(w, "WIN", "50.00");
    const rollback = await api.submit(wager(w, "ROLLBACK", "50.00", { referenceExternalTransactionId: win.externalTransactionId }));
    expect(rollback.status).toBe(202);
    await api.submit(win);
    expect(await resolveUntilTerminal(rollback.body.transactionId)).toMatchObject({ status: "PROCESSED" });
    expect(await ledgerInvariant(sql, w.id)).toMatchObject({ stored: "10.00", rebuilt: "10.00", debits: 1 });
  });

  test("a chain resolves in order: ROLLBACK(REFUND) waits for REFUND, which waits for BET", async () => {
    const w = await api.wallet("100.00");
    const bet = wager(w, "BET", "20.00");
    const refund = wager(w, "REFUND", "20.00", { referenceExternalTransactionId: bet.externalTransactionId });
    const rollback = await api.submit(wager(w, "ROLLBACK", "20.00", { referenceExternalTransactionId: refund.externalTransactionId }));
    const pendingRefund = await api.submit(refund);
    expect([rollback.status, pendingRefund.status]).toEqual([202, 202]);
    await api.submit(bet);
    expect(await resolveUntilTerminal(pendingRefund.body.transactionId)).toMatchObject({ status: "PROCESSED" });
    expect(await resolveUntilTerminal(rollback.body.transactionId)).toMatchObject({ status: "PROCESSED" });
    // BET −20, REFUND +20, ROLLBACK of REFUND −20
    expect(await ledgerInvariant(sql, w.id)).toMatchObject({ stored: "80.00", rebuilt: "80.00", entries: 4 });
  });

  test("reference never arrives: retried with backoff, then REJECTED(REFERENCE_NOT_FOUND) with an event", async () => {
    const w = await api.wallet("100.00");
    const refund = await api.submit(wager(w, "REFUND", "5.00", { referenceExternalTransactionId: "ghost-bet" }));
    const row = await resolveUntilTerminal(refund.body.transactionId);
    expect(row).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_NOT_FOUND", reference_attempts: 3 });
    expect(await eventsOf(refund.body.transactionId)).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    expect(await ledgerInvariant(sql, w.id)).toMatchObject({ stored: "100.00", entries: 1 });

    const lookup = await api.request("GET", `/wagering/transactions/${refund.body.transactionId}`);
    expect(lookup.body).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_NOT_FOUND", providerAction: "INVESTIGATE" });
  });

  test("reference that ends REJECTED → dependent REJECTED(REFERENCE_NOT_PROCESSED)", async () => {
    const w = await api.wallet("10.00");
    const bet = wager(w, "BET", "50.00"); // will be rejected: insufficient funds
    const refund = await api.submit(wager(w, "REFUND", "50.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    expect((await api.submit(bet)).status).toBe(422);
    expect(await resolveUntilTerminal(refund.body.transactionId)).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_NOT_PROCESSED" });
    expect(await ledgerInvariant(sql, w.id)).toMatchObject({ stored: "10.00", entries: 1 });
  });

  test("concurrent workers never apply a pending transaction twice", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => api.wallet("100.00")));
    const pairs = await Promise.all(
      wallets.map(async (w) => {
        const bet = wager(w, "BET", "10.00");
        const refund = await api.submit(wager(w, "REFUND", "10.00", { referenceExternalTransactionId: bet.externalTransactionId }));
        return { w, bet, refundId: refund.body.transactionId as string };
      }),
    );
    // BETs land, then four workers race over the same due set
    await Promise.all(pairs.map(({ bet }) => api.submit(bet)));
    await Promise.all(Array.from({ length: 4 }, () => resolver.runOnce(500)));
    for (const { w, refundId } of pairs) {
      const row = await resolveUntilTerminal(refundId);
      expect(row.status).toBe("PROCESSED");
      expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "100.00", rebuilt: "100.00", entries: 3, debits: 1 });
    }
  });
});
