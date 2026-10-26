import type { EntityManager } from "@mikro-orm/postgresql";
import type { InboxRepository, OutboxRepository } from "../application/ports";
import type { InboxMessage } from "../domain/inbox-message";
import type { OutboxMessage } from "../domain/outbox-message";
import { OutboxMapper } from "./messaging.mappers";
import { OutboxMessageRecord } from "./messaging.records";

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * INSERT … ON CONFLICT DO NOTHING runs immediately (not deferred to flush). If another
   * transaction is inserting the same key, Postgres makes this one wait for it: when that one
   * commits we get 0 rows (duplicate), when it rolls back our insert wins.
   */
  async tryRecord(message: InboxMessage): Promise<boolean> {
    const rows = await this.em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
    return rows.length === 1;
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.create(OutboxMessageRecord, OutboxMapper.toRecord(message));
  }
}
