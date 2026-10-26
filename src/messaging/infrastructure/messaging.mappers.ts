import type { RequiredEntityData } from "@mikro-orm/core";
import { InboxMessage } from "../domain/inbox-message";
import { OutboxMessage } from "../domain/outbox-message";
import type { InboxMessageRecord, OutboxMessageRecord } from "./messaging.records";

export const InboxMapper = {
  toDomain(record: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: record.messageId,
      consumerName: record.consumerName,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt ?? undefined,
    });
  },

  toRecord(message: InboxMessage): RequiredEntityData<InboxMessageRecord> {
    return {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    };
  },
};

export const OutboxMapper = {
  toDomain(record: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt ?? undefined,
      publishedAt: record.publishedAt ?? undefined,
    });
  },

  toRecord(message: OutboxMessage): RequiredEntityData<OutboxMessageRecord> {
    return {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload as Record<string, unknown>,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? null,
      publishedAt: message.publishedAt ?? null,
    };
  },
};
