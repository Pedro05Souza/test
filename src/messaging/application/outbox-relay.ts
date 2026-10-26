import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, LOGGER, METRICS, type Clock, type Logger, type Metrics } from "../../shared/application/ports";
import { faultPoint } from "../../shared/infrastructure/fault-injection";
import { EVENT_PUBLISHER, OUTBOX_STORE, type EventPublisher, type OutboxStore } from "./ports";

export const OUTBOX_RELAY_OPTIONS = Symbol("OutboxRelayOptions");
export interface OutboxRelayOptions {
  batchSize: number;
  leaseMs: number;
}

export interface RelayRunResult {
  claimed: number;
  published: string[];
  failed: string[];
}

/**
 * Moves committed events from the outbox to the broker: claim (lease) → publish → mark.
 * Safe with any number of concurrent relays (disjoint claims) and with crashes at any point
 * (expired leases are re-claimed; re-publishing is deduplicated by eventId).
 */
@Injectable()
export class OutboxRelay {
  constructor(
    @Inject(OUTBOX_STORE) private readonly store: OutboxStore,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(OUTBOX_RELAY_OPTIONS) private readonly options: OutboxRelayOptions,
  ) {}

  async runOnce(): Promise<RelayRunResult> {
    const claimed = await this.store.claimDue(this.options.batchSize, this.options.leaseMs);
    if (claimed.length > 0) {
      faultPoint("outbox:after-claim-before-publish");
      const { published, failed } = await this.publisher.publish(claimed);
      if (published.length > 0) {
        await this.store.markPublished(published, this.clock.now());
        this.metrics.outboxPublished(published.length);
      }
      const byId = new Map(claimed.map((m) => [m.id, m]));
      for (const { id, error } of failed) {
        const message = byId.get(id)!;
        message.scheduleRetry(this.clock.now());
        await this.store.recordFailure(message, error);
        this.metrics.retry("outbox");
        this.logger.warn("outbox publish failed, retry scheduled", {
          eventId: id,
          eventType: message.eventType,
          aggregateId: message.aggregateId,
          attempts: message.attempts,
          nextAttemptAt: message.nextAttemptAt?.toISOString(),
          error,
        });
      }
      this.metrics.outboxLag(await this.store.oldestPendingAgeSeconds());
      return { claimed: claimed.length, published, failed: failed.map((f) => f.id) };
    }
    this.metrics.outboxLag(await this.store.oldestPendingAgeSeconds());
    return { claimed: 0, published: [], failed: [] };
  }
}
