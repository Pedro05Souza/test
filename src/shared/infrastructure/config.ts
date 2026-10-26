/** Runtime configuration from environment variables, with local-development defaults. */
export interface MessagingConfig {
  sqsEndpoint: string;
  region: string;
  wagerQueue: string;
  wagerDlq: string;
  eventsQueue: string;
  /** Long-poll duration for ReceiveMessage (0–20 s). */
  receiveWaitSeconds: number;
  /** Receive attempts before SQS redrives a message to the DLQ (must match the queue's RedrivePolicy). */
  maxReceiveCount: number;
  /** Visibility backoff for transient failures: min(base · 2^(n-1), max) seconds. */
  retryBaseDelaySeconds: number;
  retryMaxDelaySeconds: number;
  consumerEnabled: boolean;
  publisherEnabled: boolean;
  outboxBatchSize: number;
  /** How long a claimed outbox row is reserved for the claiming publisher before others may take it. */
  outboxLeaseMs: number;
  outboxIdlePollMs: number;
  /** On SIGTERM, how long in-flight messages may take before we give up waiting. */
  shutdownGraceMs: number;
}

const bool = (value: string | undefined, fallback: boolean) => (value === undefined ? fallback : value === "true");
const num = (value: string | undefined, fallback: number) => (value === undefined ? fallback : Number(value));

export function loadMessagingConfig(env = process.env): MessagingConfig {
  return {
    sqsEndpoint: env.SQS_ENDPOINT ?? "http://localhost:4566",
    region: env.AWS_REGION ?? "us-east-1",
    wagerQueue: env.SQS_WAGER_QUEUE ?? "wager-transactions.fifo",
    wagerDlq: env.SQS_WAGER_DLQ ?? "wager-transactions-dlq.fifo",
    eventsQueue: env.SQS_EVENTS_QUEUE ?? "wagering-events.fifo",
    receiveWaitSeconds: num(env.SQS_WAIT_SECONDS, 10),
    maxReceiveCount: num(env.SQS_MAX_RECEIVE_COUNT, 5),
    retryBaseDelaySeconds: num(env.SQS_RETRY_BASE_DELAY_SECONDS, 2),
    retryMaxDelaySeconds: num(env.SQS_RETRY_MAX_DELAY_SECONDS, 300),
    consumerEnabled: bool(env.SQS_CONSUMER_ENABLED, true),
    publisherEnabled: bool(env.OUTBOX_PUBLISHER_ENABLED, true),
    outboxBatchSize: num(env.OUTBOX_BATCH_SIZE, 50),
    outboxLeaseMs: num(env.OUTBOX_LEASE_MS, 30_000),
    outboxIdlePollMs: num(env.OUTBOX_IDLE_POLL_MS, 250),
    shutdownGraceMs: num(env.SHUTDOWN_GRACE_MS, 15_000),
  };
}
