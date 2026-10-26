import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Api, db, ledgerInvariant, wager, type WagerPayload } from "../support/api";
import { startInstance, type Instance } from "../support/instances";
import { createIsolatedQueues, drain, queueDepth, send, waitFor, wagerMessage, type IsolatedQueues } from "../support/queues";

/**
 * Concurrency across REAL separate processes (section 13, scenarios 4–8). Every instance is
 * `bun run src/main.ts` with its own event loop, DB pool, SQS consumer, outbox publisher and
 * pending-reference worker — exactly like the replicas in docker-compose.
 */
const sql = db();
afterAll(async () => {
  await sql.close();
});

/** Fast timings so crash/redelivery scenarios complete in seconds. */
const FAST = {
  SQS_WAIT_SECONDS: "1",
  SQS_RETRY_BASE_DELAY_SECONDS: "1",
  SQS_RETRY_MAX_DELAY_SECONDS: "2",
  OUTBOX_LEASE_MS: "2000",
  OUTBOX_IDLE_POLL_MS: "100",
  PENDING_REFERENCE_POLL_MS: "100",
  REFERENCE_BASE_DELAY_MS: "200",
  REFERENCE_MAX_DELAY_MS: "1000",
  SHUTDOWN_GRACE_MS: "5000",
};

const txStatus = async (providerId: string, externalId: string) =>
  (await sql`SELECT status, failure_code FROM wager_transactions WHERE provider_id = ${providerId} AND external_transaction_id = ${externalId}`)[0];

async function waitForTransactions(walletIds: string[], expected: number, timeoutMs = 60_000) {
  await waitFor(async () => {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id IN ${sql(walletIds)} AND kind <> 'OPENING' AND status <> 'PENDING_REFERENCE'`;
    return n >= expected;
  }, timeoutMs, 200);
}

describe("three instances serving the same wallets", () => {
  let queues: IsolatedQueues;
  let instances: Instance[] = [];
  let apis: Api[] = [];

  beforeAll(async () => {
    queues = await createIsolatedQueues("multi", 5, 5);
    instances = await Promise.all(["i1", "i2", "i3"].map((name) => startInstance(name, { ...queues.env, ...FAST })));
    apis = instances.map((i) => new Api(i.baseUrl));
  }, 90_000);
  afterAll(async () => {
    await Promise.all(instances.map((i) => i.stop()));
    // graceful SIGTERM: every worker of every process reports it drained before exit
    for (const i of instances) {
      const stopped = i.logs.filter((l) => l.msg === "worker stopped");
      expect(stopped.map((l) => [l.worker, l.drained]).sort()).toEqual([
        ["outbox-publisher", true],
        ["pending-reference-worker", true],
        ["wager-transactions-consumer", true],
      ]);
    }
  }, 30_000);

  test("section 8 race with each bet on a different process: one PROCESSED, one REJECTED, one debit (×15)", async () => {
    for (let round = 0; round < 15; round++) {
      const w = await apis[round % 3]!.wallet("100.00");
      const [a, b] = await Promise.all([
        apis[round % 3]!.submit(wager(w, "BET", "80.00")),
        apis[(round + 1) % 3]!.submit(wager(w, "BET", "80.00")),
      ]);
      expect([a.body.status, b.body.status].sort()).toEqual(["PROCESSED", "REJECTED"]);
      expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "20.00", rebuilt: "20.00", entries: 2, debits: 1 });
    }
  }, 60_000);

  test("the same bet sent 50 times across 3 processes debits once", async () => {
    const w = await apis[0]!.wallet("100.00");
    const payload = wager(w, "BET", "10.00");
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => apis[i % 3]!.submit(payload)));
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "90.00", rebuilt: "90.00", entries: 2, debits: 1 });
  });

  test("hot wallet hammered by 3 processes (HTTP + SQS at once): never negative, exact", async () => {
    const w = await apis[0]!.wallet("30.00");
    const viaSqs = Array.from({ length: 30 }, () => wager(w, "BET", "1.00"));
    for (const p of viaSqs) await send(queues.wagerUrl, wagerMessage({ ...p }), { groupId: `${w.id}-${Math.random()}` });
    const viaHttp = await Promise.all(Array.from({ length: 30 }, (_, i) => apis[i % 3]!.submit(wager(w, "BET", "1.00"))));
    void viaHttp;
    await waitForTransactions([w.id], 60);
    const [{ processed, rejected }] = await sql`
      SELECT count(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
             count(*) FILTER (WHERE status = 'REJECTED' AND failure_code = 'INSUFFICIENT_FUNDS')::int AS rejected
        FROM wager_transactions WHERE wallet_id = ${w.id} AND kind = 'BET'`;
    expect({ processed, rejected }).toEqual({ processed: 30, rejected: 30 });
    expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "0.00", rebuilt: "0.00", entries: 31, debits: 30 });
  }, 60_000);

  test("independent wallets in parallel across processes and competing consumers, with duplicate deliveries", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, (_, i) => apis[i % 3]!.wallet("100.00")));
    for (const w of wallets) {
      for (let k = 0; k < 5; k++) {
        const message = wagerMessage({ ...wager(w, "BET", "3.00") });
        await send(queues.wagerUrl, message, { groupId: w.id });
        await send(queues.wagerUrl, message, { groupId: w.id }); // broker duplicate (new dedup id)
      }
    }
    await waitForTransactions(wallets.map((w) => w.id), 50);
    await waitFor(async () => {
      const d = await queueDepth(queues.wagerUrl);
      return d.visible + d.inFlight === 0;
    }, 30_000, 200);
    for (const w of wallets) {
      expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "85.00", rebuilt: "85.00", entries: 6, debits: 5 });
    }
    // the work was actually shared between processes
    const consumersThatWorked = instances.filter((i) => i.logs.some((l) => l.msg === "wager transaction handled" && l.messageId));
    expect(consumersThatWorked.length).toBeGreaterThanOrEqual(2);
  }, 90_000);

  test("REFUND delivered before its BET (via SQS) resolves through the pending-reference workers", async () => {
    const w = await apis[0]!.wallet("100.00");
    const bet = wager(w, "BET", "25.00");
    const refund = wager(w, "REFUND", "25.00", { referenceExternalTransactionId: bet.externalTransactionId });
    await send(queues.wagerUrl, wagerMessage({ ...refund }), { groupId: w.id });
    await waitFor(async () => (await txStatus("provider-a", refund.externalTransactionId))?.status === "PENDING_REFERENCE", 20_000);
    await send(queues.wagerUrl, wagerMessage({ ...bet }), { groupId: w.id });
    await waitFor(async () => (await txStatus("provider-a", refund.externalTransactionId))?.status === "PROCESSED", 30_000);
    expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "100.00", rebuilt: "100.00", entries: 3, debits: 1 });
  }, 60_000);

  test("every committed event is eventually published by the competing outbox publishers", async () => {
    await waitFor(async () => {
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
      return n === 0;
    }, 30_000, 200);
    const published = await drain(queues.eventsUrl);
    const ids = published.map((m) => JSON.parse(m.Body!).eventId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates delivered
  }, 60_000);
});

describe("crash recovery", () => {
  test("worker killed after COMMIT and before ACK: redelivered to another process, applied once", async () => {
    const queues = await createIsolatedQueues("crash-ack", 5, 2);
    const env = { ...queues.env, ...FAST, OUTBOX_PUBLISHER_ENABLED: "false", PENDING_REFERENCE_WORKER_ENABLED: "false" };
    const victim = await startInstance("victim", { ...env, FAULT_POINT: "consumer:after-commit-before-ack" });
    const api = new Api(victim.baseUrl);
    const w = await api.wallet("100.00");
    const payload = wager(w, "BET", "40.00");
    const message = wagerMessage({ ...payload });
    await send(queues.wagerUrl, message, { groupId: w.id });

    expect(await victim.exited).toBe("SIGKILL"); // killed itself right after COMMIT
    expect(await txStatus("provider-a", payload.externalTransactionId)).toMatchObject({ status: "PROCESSED" });
    expect((await queueDepth(queues.wagerUrl)).visible + (await queueDepth(queues.wagerUrl)).inFlight).toBe(1); // never acked

    const survivor = await startInstance("survivor", env);
    try {
      await waitFor(async () => {
        const d = await queueDepth(queues.wagerUrl);
        return d.visible + d.inFlight === 0;
      }, 30_000, 200);
      const replay = survivor.logs.find((l) => l.messageId === message.messageId && l.msg === "wager transaction handled");
      expect(replay).toMatchObject({ idempotentReplay: true });
      expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "60.00", rebuilt: "60.00", entries: 2, debits: 1 });
    } finally {
      await survivor.stop();
    }
  }, 90_000);

  test("publisher killed after claiming (commit → crash before publish): another process publishes after the lease", async () => {
    const queues = await createIsolatedQueues("crash-outbox", 5, 5);
    const env = { ...queues.env, ...FAST, SQS_CONSUMER_ENABLED: "false", PENDING_REFERENCE_WORKER_ENABLED: "false" };
    // drain any backlog so the victim's first claim contains our event
    const sweeper = await startInstance("sweeper", { ...env, SQS_EVENTS_QUEUE: queues.env.SQS_EVENTS_QUEUE! });
    await waitFor(async () => (await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`)[0].n === 0, 30_000, 200);
    await sweeper.stop();
    await drain(queues.eventsUrl);

    const victim = await startInstance("outbox-victim", { ...env, FAULT_POINT: "outbox:after-claim-before-publish" });
    const eventId = Bun.randomUUIDv7();
    await sql`INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
              VALUES (${eventId}, ${"agg-" + eventId}, 'CrashTest', ${sql.json({ eventId })}, now(), 0, now())`;
    expect(await victim.exited).toBe("SIGKILL");
    const [leased] = await sql`SELECT published_at, next_attempt_at > now() AS leased FROM outbox_messages WHERE id = ${eventId}`;
    expect(leased).toEqual({ published_at: null, leased: true }); // claimed, not published, not lost

    const successor = await startInstance("outbox-successor", env);
    try {
      await waitFor(async () => (await sql`SELECT published_at FROM outbox_messages WHERE id = ${eventId}`)[0].published_at, 20_000, 200);
      const delivered = (await drain(queues.eventsUrl)).map((m) => JSON.parse(m.Body!).eventId);
      expect(delivered).toContain(eventId);
    } finally {
      await successor.stop();
    }
  }, 90_000);
});

describe("restart of the whole fleet under load", () => {
  test("SIGKILL all 3 processes mid-load, restart: every message applied exactly once, ledger consistent", async () => {
    const queues = await createIsolatedQueues("restart", 10, 3);
    const env = { ...queues.env, ...FAST };
    const first = await Promise.all(["r1", "r2", "r3"].map((n) => startInstance(n, env)));
    const api = new Api(first[0]!.baseUrl);
    const wallets = await Promise.all(Array.from({ length: 10 }, () => api.wallet("100.00")));
    const payloads: WagerPayload[] = [];
    for (const w of wallets) {
      for (let k = 0; k < 10; k++) {
        const p = wager(w, "BET", "2.50");
        payloads.push(p);
        await send(queues.wagerUrl, wagerMessage({ ...p }), { groupId: w.id });
      }
    }
    // let some (not all) work happen, then pull the plug on every process
    await waitFor(async () => {
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id IN ${sql(wallets.map((w) => w.id))} AND kind = 'BET'`;
      return n >= 10;
    }, 30_000, 20);
    for (const i of first) i.kill();
    await Promise.all(first.map((i) => i.exited));

    const second = await Promise.all(["r4", "r5", "r6"].map((n) => startInstance(n, env)));
    try {
      await waitForTransactions(wallets.map((w) => w.id), 100, 90_000);
      await waitFor(async () => {
        const d = await queueDepth(queues.wagerUrl);
        return d.visible + d.inFlight === 0;
      }, 60_000, 200);

      const secondApi = new Api(second[1]!.baseUrl);
      for (const w of wallets) {
        expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "75.00", rebuilt: "75.00", entries: 11, debits: 10 });
        const recon = await secondApi.request("POST", `/wallets/${w.id}/reconciliation`);
        expect(recon.body).toMatchObject({ consistent: true, checkedEntries: 11 });
      }
      const [{ duplicates }] = await sql`
        SELECT count(*)::int AS duplicates FROM (
          SELECT transaction_id FROM wallet_ledger_entries WHERE wallet_id IN ${sql(wallets.map((w) => w.id))}
          GROUP BY transaction_id HAVING count(*) > 1) d`;
      expect(duplicates).toBe(0);
      // and nothing committed was lost on the event side
      await waitFor(async () => (await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`)[0].n === 0, 30_000, 200);
    } finally {
      await Promise.all(second.map((i) => i.stop()));
    }
  }, 180_000);
});
