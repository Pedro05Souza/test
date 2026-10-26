import type { IntegrationEvent } from "../../shared/domain/integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

/**
 * An integration event persisted in the same SQL transaction as the change that raised it,
 * waiting to be published. Its id is the event id, which is also the SQS deduplication id —
 * so a duplicate publish is harmless for consumers.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) return; // publishing twice is harmless; keep the first timestamp
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Increments attempts and schedules the next try with exponential backoff (1s · 2^n, max 60s). */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this._attempts - 1), RETRY_MAX_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
