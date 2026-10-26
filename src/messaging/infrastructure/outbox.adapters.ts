import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { translateDbError } from "../../shared/infrastructure/database/db-errors";
import type { EventPublisher, OutboxStore, PublishResult } from "../application/ports";
import { OutboxMessage } from "../domain/outbox-message";

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
}

export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claimDue(limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = await this.exec<OutboxRow[]>(
      `UPDATE outbox_messages o
          SET next_attempt_at = now() + (? || ' milliseconds')::interval
        WHERE o.id IN (
              SELECT id FROM outbox_messages
               WHERE published_at IS NULL AND next_attempt_at <= now()
               ORDER BY next_attempt_at, occurred_at
               LIMIT ?
               FOR UPDATE SKIP LOCKED)
       RETURNING o.id, o.aggregate_id, o.event_type, o.payload, o.occurred_at, o.attempts, o.next_attempt_at, o.published_at`,
      [String(Math.trunc(leaseMs)), limit],
    );
    return rows
      .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime())
      .map((row) =>
        OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
          occurredAt: new Date(row.occurred_at),
          attempts: row.attempts,
          nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at) : undefined,
          publishedAt: row.published_at ? new Date(row.published_at) : undefined,
        }),
      );
  }

  async markPublished(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.exec(
      `UPDATE outbox_messages SET published_at = ?, next_attempt_at = NULL, last_error = NULL
        WHERE id = ANY(?::uuid[]) AND published_at IS NULL`,
      [at, `{${ids.join(",")}}`],
    );
  }

  async recordFailure(message: OutboxMessage, error: string): Promise<void> {
    await this.exec(
      `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ?, last_error = ?
        WHERE id = ? AND published_at IS NULL`,
      [message.attempts, message.nextAttemptAt ?? new Date(), error.slice(0, 500), message.id],
    );
  }

  async oldestPendingAgeSeconds(): Promise<number> {
    const [row] = await this.exec<{ age: string | null }[]>(
      `SELECT EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))::text AS age FROM outbox_messages WHERE published_at IS NULL`,
    );
    return row?.age ? Math.max(0, Number(row.age)) : 0;
  }

  private async exec<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
    try {
      return (await this.orm.em.fork().execute(sql, params)) as T;
    } catch (error) {
      throw translateDbError(error);
    }
  }
}

const SQS_BATCH_MAX = 10;

/**
 * Publishes to a FIFO queue: MessageGroupId = aggregateId (per-aggregate ordering),
 * MessageDeduplicationId = eventId (broker-side dedup of re-publishes within 5 minutes).
 * The body is the stored envelope verbatim; consumers dedupe by eventId beyond that window.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const result: PublishResult = { published: [], failed: [] };
    for (let i = 0; i < messages.length; i += SQS_BATCH_MAX) {
      const chunk = messages.slice(i, i + SQS_BATCH_MAX);
      try {
        const out = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: chunk.map((m, index) => ({
              Id: String(index),
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: m.aggregateId,
              MessageDeduplicationId: m.id,
              MessageAttributes: { eventType: { DataType: "String", StringValue: m.eventType } },
            })),
          }),
        );
        for (const ok of out.Successful ?? []) result.published.push(chunk[Number(ok.Id)]!.id);
        for (const ko of out.Failed ?? []) {
          result.failed.push({ id: chunk[Number(ko.Id)]!.id, error: `${ko.Code}: ${ko.Message ?? ""}` });
        }
      } catch (error) {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        for (const m of chunk) result.failed.push({ id: m.id, error: reason });
      }
    }
    return result;
  }
}
