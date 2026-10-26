import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WagerTransactionConsumer } from "../../src/wagering/sqs/wager-transaction.consumer";
import { Api, db, ledgerInvariant, wager } from "../support/api";
import { startApp, type RunningApp } from "../support/app";
import { createIsolatedQueues, drain, queueDepth, send, waitFor, wagerMessage, type IsolatedQueues } from "../support/queues";

/**
 * SQS consumer against the real emulator and real Postgres. The consumer loop is off; tests call
 * pollOnce() so every receive is deterministic. Queue redrive: maxReceiveCount = 3.
 */
let running: RunningApp;
let api: Api;
let queues: IsolatedQueues;
let consumer: WagerTransactionConsumer;
const sql = db();

beforeAll(async () => {
  queues = await createIsolatedQueues("consumer", 3);
  running = await startApp({
    env: {
      ...queues.env,
      DB_LOCK_TIMEOUT_MS: "300",
      SQS_RETRY_BASE_DELAY_SECONDS: "1",
      SQS_RETRY_MAX_DELAY_SECONDS: "1",
      SQS_WAIT_SECONDS: "1",
      SHUTDOWN_GRACE_MS: "5000",
    },
  });
  api = new Api(running.baseUrl);
  consumer = running.app.get(WagerTransactionConsumer);
});
afterAll(async () => {
  await running.close();
  await sql.close();
});

/** Polls until the queue has nothing visible or in flight. */
async function consumeAll(maxPolls = 20) {
  for (let i = 0; i < maxPolls; i++) {
    const received = await consumer.pollOnce(1);
    const depth = await queueDepth(queues.wagerUrl);
    if (received === 0 && depth.visible === 0 && depth.inFlight === 0) return;
  }
  throw new Error("queue did not drain");
}

const txByExternal = async (externalId: string) =>
  (await sql`SELECT id, status, failure_code FROM wager_transactions WHERE external_transaction_id = ${externalId}`)[0];
const inboxRow = async (messageId: string) =>
  (await sql`SELECT consumer_name, processed_at IS NOT NULL AS processed FROM inbox_messages WHERE message_id = ${messageId}`)[0];

describe("happy path", () => {
  test("a message is processed through the shared use case, recorded in the inbox and acked after commit", async () => {
    const w = await api.wallet("100.00");
    const payload = wager(w, "BET", "25.00");
    const message = wagerMessage({ ...payload });
    await send(queues.wagerUrl, message, { groupId: w.id });

    await consumeAll();

    expect(await txByExternal(payload.externalTransactionId)).toMatchObject({ status: "PROCESSED" });
    expect(await inboxRow(message.messageId)).toEqual({ consumer_name: "wager-transactions-consumer", processed: true });
    expect(await queueDepth(queues.wagerUrl)).toEqual({ visible: 0, inFlight: 0 });
    expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "75.00", rebuilt: "75.00", entries: 2, debits: 1 });
  });

  test("a business rejection is a terminal outcome: persisted REJECTED and acked (not retried, not DLQ)", async () => {
    const w = await api.wallet("10.00");
    const payload = wager(w, "BET", "50.00");
    await send(queues.wagerUrl, wagerMessage({ ...payload }), { groupId: w.id });
    await consumeAll();
    expect(await txByExternal(payload.externalTransactionId)).toMatchObject({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    expect(await drain(queues.dlqUrl)).toHaveLength(0);
  });

  test("messages of one wallet (same group) are applied in order", async () => {
    const w = await api.wallet("10.00");
    const win = wager(w, "WIN", "90.00");
    const bet = wager(w, "BET", "100.00"); // only affordable after the WIN
    await send(queues.wagerUrl, wagerMessage({ ...win }), { groupId: w.id });
    await send(queues.wagerUrl, wagerMessage({ ...bet }), { groupId: w.id });
    await consumeAll();
    expect(await txByExternal(bet.externalTransactionId)).toMatchObject({ status: "PROCESSED" });
    expect(await ledgerInvariant(sql, w.id)).toMatchObject({ stored: "0.00", rebuilt: "0.00" });
  });
});

describe("redelivery and duplicates", () => {
  test("the same messageId delivered again (broker duplicate) never applies twice", async () => {
    const w = await api.wallet("100.00");
    const message = wagerMessage({ ...wager(w, "BET", "10.00") });
    // different SQS dedup ids → the broker delivers all three; the inbox must absorb them
    for (let i = 0; i < 3; i++) await send(queues.wagerUrl, message, { groupId: w.id });
    await consumeAll();
    expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "90.00", rebuilt: "90.00", entries: 2, debits: 1 });
    const metrics = await fetch(`${running.baseUrl}/metrics`).then((r) => r.text());
    expect(metrics).toMatch(/wagering_duplicates_detected_total\{type="inbox_redelivery"\} [2-9]/);
  });

  test("the same operation via HTTP and SQS (same idempotency key) applies once", async () => {
    const w = await api.wallet("100.00");
    const payload = wager(w, "BET", "10.00");
    expect((await api.submit(payload)).status).toBe(201);
    await send(queues.wagerUrl, wagerMessage({ ...payload }), { groupId: w.id });
    await consumeAll();
    expect(await ledgerInvariant(sql, w.id)).toMatchObject({ stored: "90.00", debits: 1 });
    expect(await drain(queues.dlqUrl)).toHaveLength(0); // replay → ack
  });
});

describe("permanent failures go to the DLQ", () => {
  test.each([
    ["malformed JSON", "{not json", "MALFORMED_JSON"],
    ["schema violation", { messageId: "m", type: "WagerTransactionRequested", occurredAt: "x", data: {} }, "INVALID_MESSAGE"],
    ["OPENING kind", null, "INVALID_MESSAGE"],
  ])("%s → DLQ with reason, removed from the main queue", async (_label, body, reason) => {
    const w = await api.wallet("100.00");
    const message = body ?? wagerMessage({ ...wager(w, "BET", "1.00"), kind: "OPENING" });
    await send(queues.wagerUrl, message, { groupId: w.id });
    await consumeAll();
    const dead = await drain(queues.dlqUrl);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.MessageAttributes?.reason?.StringValue).toBe(reason);
    expect(await ledgerInvariant(sql, w.id)).toMatchObject({ entries: 1 });
  });

  test("unknown wallet → DLQ (WALLET_NOT_FOUND)", async () => {
    const ghost = { id: Bun.randomUUIDv7(), playerId: "p" };
    await send(queues.wagerUrl, wagerMessage({ ...wager(ghost, "BET", "1.00") }), { groupId: ghost.id });
    await consumeAll();
    const dead = await drain(queues.dlqUrl);
    expect(dead.map((m) => m.MessageAttributes?.reason?.StringValue)).toEqual(["WALLET_NOT_FOUND"]);
  });

  test("idempotency conflict → DLQ, original untouched", async () => {
    const w = await api.wallet("100.00");
    const payload = wager(w, "BET", "10.00");
    await api.submit(payload);
    await send(queues.wagerUrl, wagerMessage({ ...payload, money: { amount: "99.00", currency: "BRL" } }), { groupId: w.id });
    await consumeAll();
    expect((await drain(queues.dlqUrl)).map((m) => m.MessageAttributes?.reason?.StringValue)).toEqual(["IDEMPOTENCY_CONFLICT"]);
    expect(await ledgerInvariant(sql, w.id)).toMatchObject({ stored: "90.00", debits: 1 });
  });
});

describe("transient failures", () => {
  /** Holds the wallet row lock from another connection, so processing hits lock_timeout (300ms) → transient. */
  function holdWalletLock(walletId: string) {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const locked = new Promise<void>((ready) => {
      sql
        .begin(async (tx) => {
          await tx`SELECT 1 FROM wallets WHERE id = ${walletId} FOR UPDATE`;
          ready();
          await released;
        })
        .catch(() => {});
    });
    return { locked, release };
  }

  test("retried with visibility backoff (no ack), then processed once the dependency recovers", async () => {
    const w = await api.wallet("100.00");
    const message = wagerMessage({ ...wager(w, "BET", "10.00") });
    const lock = holdWalletLock(w.id);
    await lock.locked;

    await send(queues.wagerUrl, message, { groupId: w.id });
    expect(await consumer.pollOnce(1)).toBe(1); // lock timeout → transient → visibility 1s
    expect(await queueDepth(queues.wagerUrl)).toMatchObject({ inFlight: 1 });
    expect(await inboxRow(message.messageId)).toBeUndefined(); // rolled back with everything else

    lock.release();
    await waitFor(async () => (await consumer.pollOnce(1)) > 0, 10_000, 0);
    expect(await inboxRow(message.messageId)).toMatchObject({ processed: true });
    expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "90.00", rebuilt: "90.00", entries: 2, debits: 1 });
  }, 20_000);

  test("after maxReceiveCount transient failures the broker redrives the message to the DLQ", async () => {
    const w = await api.wallet("100.00");
    const message = wagerMessage({ ...wager(w, "BET", "10.00") });
    const lock = holdWalletLock(w.id);
    await lock.locked;
    try {
      await send(queues.wagerUrl, message, { groupId: w.id });
      let failures = 0;
      await waitFor(async () => {
        failures += await consumer.pollOnce(1);
        return failures >= 3;
      }, 15_000, 0);
      // 4th receive attempt: SQS moves it to the DLQ instead of delivering it
      await Bun.sleep(1_100);
      expect(await consumer.pollOnce(1)).toBe(0);
      const dead = await waitFor(async () => {
        const d = await drain(queues.dlqUrl);
        return d.length ? d : undefined;
      });
      expect(JSON.parse(dead[0]!.Body!).messageId).toBe(message.messageId);
    } finally {
      lock.release();
    }
    expect(await ledgerInvariant(sql, w.id)).toMatchObject({ stored: "100.00", debits: 0 });
  }, 30_000);
});

describe("graceful shutdown", () => {
  test("stop() finishes in-flight work and releases unstarted messages; a restart completes the rest exactly once", async () => {
    const w = await api.wallet("100.00");
    const bets = Array.from({ length: 8 }, () => wager(w, "BET", "1.00"));
    for (const bet of bets) await send(queues.wagerUrl, wagerMessage({ ...bet }), { groupId: w.id });

    consumer.start();
    await waitFor(async () => (await ledgerInvariant(sql, w.id)).debits >= 1, 10_000, 5);
    await consumer.stop(5_000); // SIGTERM path

    const afterStop = await ledgerInvariant(sql, w.id);
    expect(afterStop.stored).toBe(afterStop.rebuilt);
    // nothing is stuck invisible: whatever was not applied is visible again for another instance
    expect((await queueDepth(queues.wagerUrl)).inFlight).toBe(0);

    await consumeAll(); // "another instance" / restart
    expect(await ledgerInvariant(sql, w.id)).toEqual({ stored: "92.00", rebuilt: "92.00", entries: 9, debits: 8 });
  });
});
