import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { Metrics, ProcessingSource } from "../../application/ports";

/** Prometheus metrics, exposed at GET /metrics. */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wagering_transactions_total",
    help: "Wager transactions by resulting status",
    labelNames: ["status", "kind", "source"] as const,
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: "wagering_duplicates_detected_total",
    help: "Duplicate deliveries detected (idempotent replays, inbox redeliveries, idempotency conflicts)",
    labelNames: ["type"] as const,
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: "wagering_lock_conflicts_total",
    help: "Row-lock acquisitions that had to wait for another transaction",
    labelNames: ["resource"] as const,
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: "wagering_processing_duration_seconds",
    help: "End-to-end processing latency of a wager transaction",
    labelNames: ["source"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: "wagering_retries_total",
    help: "Retries by component",
    labelNames: ["component"] as const,
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: "wagering_dlq_messages_total",
    help: "Messages routed to the dead-letter queue",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });
  private readonly reconciliations = new Counter({
    name: "wagering_reconciliations_total",
    help: "Wallet reconciliations by result",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });
  private readonly outboxLagGauge = new Gauge({
    name: "wagering_outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox message",
    registers: [this.registry],
  });
  private readonly outboxPublishedCounter = new Counter({
    name: "wagering_outbox_published_total",
    help: "Outbox messages published",
    registers: [this.registry],
  });

  constructor(collectDefaults = true) {
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });
  }

  transactionOutcome(status: string, kind: string, source: ProcessingSource): void {
    this.transactions.inc({ status, kind, source });
  }
  duplicateDetected(type: "idempotent_replay" | "inbox_redelivery" | "idempotency_conflict"): void {
    this.duplicates.inc({ type });
  }
  lockConflict(resource: "wallet"): void {
    this.lockConflicts.inc({ resource });
  }
  processingDuration(source: ProcessingSource, seconds: number): void {
    this.duration.observe({ source }, seconds);
  }
  retry(component: "uow" | "sqs_consumer" | "outbox" | "pending_reference"): void {
    this.retries.inc({ component });
  }
  deadLettered(reason: string): void {
    this.dlq.inc({ reason });
  }
  reconciliation(consistent: boolean): void {
    this.reconciliations.inc({ result: consistent ? "consistent" : "divergent" });
  }
  outboxLag(seconds: number): void {
    this.outboxLagGauge.set(seconds);
  }
  outboxPublished(count: number): void {
    this.outboxPublishedCounter.inc(count);
  }
}
