import { defineEntity, p, type InferEntity } from "@mikro-orm/core";

export const InboxMessageRecord = defineEntity({
  name: "InboxMessageRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: p.string().length(64).primary(),
    messageId: p.string().length(128).primary(),
    payloadHash: p.string().length(64),
    receivedAt: p.datetime().columnType("timestamptz"),
    processedAt: p.datetime().columnType("timestamptz").nullable(),
  },
});
export type InboxMessageRecord = InferEntity<typeof InboxMessageRecord>;

export const OutboxMessageRecord = defineEntity({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.string().length(128),
    eventType: p.string().length(64),
    payload: p.json<Record<string, unknown>>().columnType("jsonb"),
    occurredAt: p.datetime().columnType("timestamptz"),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().columnType("timestamptz").nullable(),
    publishedAt: p.datetime().columnType("timestamptz").nullable(),
    lastError: p.string().length(500).nullable(),
  },
});
export type OutboxMessageRecord = InferEntity<typeof OutboxMessageRecord>;
