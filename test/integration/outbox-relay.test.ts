import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OutboxRelay } from "../../src/messaging/application/outbox-relay";
import { PostgresOutboxStore, SqsEventPublisher } from "../../src/messaging/infrastructure/outbox.adapters";
import { MikroORM } from "@mikro-orm/postgresql";
import { SystemClock } from "../../src/shared/infrastructure/system";
import { PrometheusMetrics } from "../../src/shared/infrastructure/observability/metrics";
import { createLogger } from "../../src/shared/infrastructure/observability/logger";
import { Api, db, wager } from "../support/api";
import { startApp, type RunningApp } from "../support/app";
import { createIsolatedQueues, drain, sqs, type IsolatedQueues } from "../support/queues";

/** Transactional outbox → SQS, with real Postgres and the real emulator. Publisher loop is off. */
let running: RunningApp;
let api: Api;
let queues: IsolatedQueues;
let store: PostgresOutboxStore;
/** Throwaway queue for the backlog other suites left behind, so assertions only see this suite's events. */
let sinkUrl: string;
const sql = db();

beforeAll(async () => {
  queues = await createIsolatedQueues("outbox");
  sinkUrl = (await createIsolatedQueues("outbox-sink")).eventsUrl;
  running = await startApp({ env: { ...queues.env, OUTBOX_LEASE_MS: "500" } });
  api = new Api(running.baseUrl);
  store = new PostgresOutboxStore(running.app.get(MikroORM));
  await drainOutbox(); // start from an empty backlog (other suites leave unpublished events)
});
afterAll(async () => {
  await running.close();
  await sql.close();
});

function relay(publisherQueueUrl = queues.eventsUrl, leaseMs = 500) {
  return new OutboxRelay(
    store,
    new SqsEventPublisher(sqs, publisherQueueUrl),
    new SystemClock(),
    new PrometheusMetrics(false),
    createLogger("silent"),
    { batchSize: 20, leaseMs },
  );
}

async function drainOutbox() {
  const r = relay(sinkUrl);
  for (let i = 0; i < 1_000; i++) if ((await r.runOnce()).claimed === 0) return;
}

const pendingIds = async (ids: string[]) =>
  (await sql`SELECT id FROM outbox_messages WHERE id IN ${sql(ids)} AND published_at IS NULL`).map((r: { id: string }) => r.id);

async function insertEvents(n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, () => Bun.randomUUIDv7());
  for (const id of ids) {
    await sql`INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
              VALUES (${id}, ${"agg-" + id}, 'TestEvent', ${sql.json({ eventId: id })}, now(), 0, now())`;
  }
  return ids;
}

describe("outbox relay", () => {
  test("publishes committed events to SQS: envelope body, dedup id = eventId, then marks them published", async () => {
    const w = await api.wallet("100.00");
    const bet = await api.submit(wager(w, "BET", "10.00"));
    const rows = await sql`SELECT id, event_type FROM outbox_messages WHERE aggregate_id IN (${w.id}, ${bet.body.transactionId})`;
    expect(rows).toHaveLength(3); // opening WalletBalanceChanged + Processed + WalletBalanceChanged

    await relay().runOnce();
    expect(await pendingIds(rows.map((r: { id: string }) => r.id))).toEqual([]);

    const received = await drain(queues.eventsUrl);
    const ours = received.filter((m) => rows.some((r: { id: string }) => r.id === JSON.parse(m.Body!).eventId));
    expect(ours).toHaveLength(3);
    for (const m of ours) {
      const envelope = JSON.parse(m.Body!);
      expect(m.Attributes?.MessageDeduplicationId).toBe(envelope.eventId);
      expect(envelope).toMatchObject({ version: 1, correlationId: expect.any(String), occurredAt: expect.any(String) });
      expect(m.MessageAttributes?.eventType?.StringValue).toBe(envelope.eventType);
    }
    const processed = ours.map((m) => JSON.parse(m.Body!)).find((e) => e.eventType === "WagerTransactionProcessed");
    expect(processed.data).toMatchObject({ transactionId: bet.body.transactionId, money: { amount: "10.00", currency: "BRL" } });
  });

  test("two concurrent publishers claim disjoint sets: every event published, none by both", async () => {
    const ids = await insertEvents(60);
    const [a, b] = [relay(), relay()];
    const byA: string[] = [];
    const byB: string[] = [];
    for (let round = 0; round < 10 && (await pendingIds(ids)).length > 0; round++) {
      const [ra, rb] = await Promise.all([a.runOnce(), b.runOnce()]);
      byA.push(...ra.published);
      byB.push(...rb.published);
    }
    const ours = new Set(ids);
    const aOurs = byA.filter((id) => ours.has(id));
    const bOurs = byB.filter((id) => ours.has(id));
    expect(aOurs.filter((id) => bOurs.includes(id))).toEqual([]);
    expect(new Set([...aOurs, ...bOurs]).size).toBe(60);
    expect(aOurs.length).toBeGreaterThan(0);
    expect(bOurs.length).toBeGreaterThan(0);
    await drain(queues.eventsUrl);
  });

  test("publisher dies after claiming (commit → crash before publish): another takes over after the lease", async () => {
    const id = (await insertEvents(1))[0]!;
    const claimed = await store.claimDue(100, 500); // crashed publisher: claims, never publishes
    expect(claimed.map((m) => m.id)).toContain(id);

    const survivor = relay();
    expect((await survivor.runOnce()).published).not.toContain(id); // still leased
    await Bun.sleep(600);
    expect((await survivor.runOnce()).published).toContain(id);
    expect(await pendingIds([id])).toEqual([]);
    const published = (await drain(queues.eventsUrl)).map((m) => JSON.parse(m.Body!).eventId);
    expect(published).toContain(id);
  });

  test("broker unavailable: attempts + backoff + last error are recorded, then the event goes out", async () => {
    const id = (await insertEvents(1))[0]!;
    const broken = relay(`${queues.eventsUrl}-does-not-exist`);
    const result = await broken.runOnce();
    expect(result.failed).toContain(id);

    const [row] = await sql`SELECT attempts, published_at, last_error, next_attempt_at > now() AS backed_off FROM outbox_messages WHERE id = ${id}`;
    expect(row).toMatchObject({ attempts: 1, published_at: null, backed_off: true });
    expect(row.last_error).toBeTruthy();

    await sql`UPDATE outbox_messages SET next_attempt_at = now() WHERE id = ${id}`; // skip the 1s backoff
    expect((await relay().runOnce()).published).toContain(id);
    await drain(queues.eventsUrl);
  });

  test("outbox lag is reported", async () => {
    await insertEvents(1);
    await sql`UPDATE outbox_messages SET occurred_at = now() - interval '42 seconds' WHERE published_at IS NULL AND event_type = 'TestEvent'`;
    expect(await store.oldestPendingAgeSeconds()).toBeGreaterThanOrEqual(42);
    await drainOutbox();
    expect(await store.oldestPendingAgeSeconds()).toBe(0);
  });
});
