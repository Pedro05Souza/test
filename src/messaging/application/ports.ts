import type { InboxMessage } from "../domain/inbox-message";
import type { OutboxMessage } from "../domain/outbox-message";

export interface InboxRepository {
  /**
   * Records the message as received+processed in the current transaction.
   * Returns false when (consumerName, messageId) already exists — i.e. a redelivery.
   * Implementations must use the database uniqueness, never an in-memory set.
   */
  tryRecord(message: InboxMessage): Promise<boolean>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
}

export const OUTBOX_STORE = Symbol("OutboxStore");
/** Non-transactional access used by the relay; every method is a single atomic statement. */
export interface OutboxStore {
  /**
   * Atomically claims up to `limit` due messages for this publisher by pushing their
   * next_attempt_at `leaseMs` into the future (FOR UPDATE SKIP LOCKED: concurrent publishers
   * get disjoint sets). If the claimer dies, the lease expires and others can claim them.
   */
  claimDue(limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(ids: readonly string[], at: Date): Promise<void>;
  /** Persists attempts/nextAttemptAt from `message.scheduleRetry` plus the last error. */
  recordFailure(message: OutboxMessage, error: string): Promise<void>;
  /** Age in seconds of the oldest unpublished message (0 when none) — the outbox lag. */
  oldestPendingAgeSeconds(): Promise<number>;
}

export const EVENT_PUBLISHER = Symbol("EventPublisher");
export interface PublishResult {
  published: string[];
  failed: { id: string; error: string }[];
}
/** Publishes outbox messages to the broker. Must be safe to call twice for the same message. */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}
