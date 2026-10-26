import {
  Inject,
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import type { HealthCheck } from "../health/health.controller";
import { LOGGER, METRICS, type Logger, type Metrics } from "../shared/application/ports";
import { loadMessagingConfig, type MessagingConfig } from "../shared/infrastructure/config";
import { PollingLoop } from "../shared/infrastructure/polling-loop";
import { ProcessWagerTransaction } from "../wagering/application/process-wager-transaction";
import { WagerTransactionConsumer } from "../wagering/sqs/wager-transaction.consumer";
import { WageringModule } from "../wagering/wagering.module";
import { OUTBOX_RELAY_OPTIONS, OutboxRelay } from "./application/outbox-relay";
import { EVENT_PUBLISHER, OUTBOX_STORE } from "./application/ports";
import { PostgresOutboxStore, SqsEventPublisher } from "./infrastructure/outbox.adapters";
import { QUEUE_URLS, SQS_CLIENT, checkSqs, createSqsClient, resolveQueueUrls, type QueueUrls } from "./infrastructure/sqs";

export const MESSAGING_CONFIG = Symbol("MessagingConfig");
export const SQS_HEALTH_CHECK = Symbol("SqsHealthCheck");

/** Starts the background workers after bootstrap; stops them BEFORE the DB pool closes. */
@Injectable()
export class MessagingWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly publisherLoop: PollingLoop;

  constructor(
    @Inject(MESSAGING_CONFIG) private readonly config: MessagingConfig,
    @Inject(OutboxRelay) relay: OutboxRelay,
    @Inject(WagerTransactionConsumer) private readonly consumer: WagerTransactionConsumer,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.publisherLoop = new PollingLoop(
      "outbox-publisher",
      async () => (await relay.runOnce()).claimed >= config.outboxBatchSize,
      config.outboxIdlePollMs,
      logger,
    );
  }

  onApplicationBootstrap(): void {
    if (this.config.publisherEnabled) this.publisherLoop.start();
    if (this.config.consumerEnabled) this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.consumer.stop(this.config.shutdownGraceMs), this.publisherLoop.stop(this.config.shutdownGraceMs)]);
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}

@Module({
  imports: [WageringModule],
  providers: [
    { provide: MESSAGING_CONFIG, useFactory: () => loadMessagingConfig() },
    { provide: SQS_CLIENT, inject: [MESSAGING_CONFIG], useFactory: (config: MessagingConfig) => createSqsClient(config) },
    {
      provide: QUEUE_URLS,
      inject: [SQS_CLIENT, MESSAGING_CONFIG],
      useFactory: (sqs: SQSClient, config: MessagingConfig) => resolveQueueUrls(sqs, config),
    },
    { provide: OUTBOX_STORE, inject: [MikroORM], useFactory: (orm: MikroORM) => new PostgresOutboxStore(orm) },
    {
      provide: EVENT_PUBLISHER,
      inject: [SQS_CLIENT, QUEUE_URLS],
      useFactory: (sqs: SQSClient, urls: QueueUrls) => new SqsEventPublisher(sqs, urls.events),
    },
    {
      provide: OUTBOX_RELAY_OPTIONS,
      inject: [MESSAGING_CONFIG],
      useFactory: (config: MessagingConfig) => ({ batchSize: config.outboxBatchSize, leaseMs: config.outboxLeaseMs }),
    },
    OutboxRelay,
    {
      provide: WagerTransactionConsumer,
      inject: [SQS_CLIENT, QUEUE_URLS, MESSAGING_CONFIG, ProcessWagerTransaction, METRICS, LOGGER],
      useFactory: (sqs: SQSClient, urls: QueueUrls, config: MessagingConfig, process: ProcessWagerTransaction, metrics: Metrics, logger: Logger) =>
        new WagerTransactionConsumer(sqs, urls, config, process, metrics, logger),
    },
    {
      provide: SQS_HEALTH_CHECK,
      inject: [SQS_CLIENT, QUEUE_URLS],
      useFactory: (sqs: SQSClient, urls: QueueUrls): HealthCheck => ({ name: "sqs", check: () => checkSqs(sqs, urls) }),
    },
    MessagingWorkers,
  ],
  exports: [SQS_HEALTH_CHECK, OutboxRelay, WagerTransactionConsumer, MESSAGING_CONFIG, QUEUE_URLS, SQS_CLIENT],
})
export class MessagingModule {}
