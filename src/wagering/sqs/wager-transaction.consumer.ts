import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { ValidationError } from "../../shared/application/errors";
import type { Logger, Metrics } from "../../shared/application/ports";
import type { MessagingConfig } from "../../shared/infrastructure/config";
import { faultPoint } from "../../shared/infrastructure/fault-injection";
import { RequestContext } from "../../shared/infrastructure/observability/request-context";
import { parseOrThrow } from "../../shared/http/validation";
import type { QueueUrls } from "../../messaging/infrastructure/sqs";
import type { ProcessWagerTransaction } from "../application/process-wager-transaction";
import { classifyFailure, retryDelaySeconds, wagerTransactionRequestedSchema, type WagerTransactionRequested } from "./wager-message";

export const CONSUMER_NAME = "wager-transactions-consumer";

/**
 * Consumes wager-transactions.fifo through the same use case as HTTP.
 *
 * - dedup: persistent inbox keyed by (consumerName, message.messageId), written in the same SQL
 *   transaction as the financial change;
 * - ack (DeleteMessage) only after the use case returned, i.e. after COMMIT;
 * - transient failures: no ack, visibility backoff; SQS redrives to the DLQ after maxReceiveCount;
 * - permanent failures: explicit copy to the DLQ (with reason) then delete;
 * - ordering: messages of one MessageGroupId are handled sequentially, groups in parallel;
 * - shutdown: stop polling, finish in-flight work, release (visibility 0) what was not started.
 */
export class WagerTransactionConsumer {
  private stopping = false;
  private loop?: Promise<void>;
  private abort = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly urls: QueueUrls,
    private readonly config: MessagingConfig,
    private readonly processWager: ProcessWagerTransaction,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.abort = new AbortController();
    this.loop = this.run();
    this.logger.info("worker started", { worker: CONSUMER_NAME });
  }

  async stop(graceMs = this.config.shutdownGraceMs): Promise<void> {
    this.stopping = true;
    this.abort.abort(); // interrupt the long poll
    const drained = await Promise.race([
      Promise.allSettled([this.loop, ...this.inFlight]).then(() => true),
      Bun.sleep(graceMs).then(() => false),
    ]);
    // Anything still running past the grace period will reappear after its visibility timeout;
    // the inbox guarantees it is not applied twice.
    this.logger.info("worker stopped", { worker: CONSUMER_NAME, drained });
    this.loop = undefined;
    if (drained) {
      // fully idle again: allow a later start()/pollOnce() (e.g. restart in the same process)
      this.stopping = false;
      this.abort = new AbortController();
    }
  }

  /** One receive + handle cycle. Returns the number of messages received. */
  async pollOnce(waitSeconds = this.config.receiveWaitSeconds): Promise<number> {
    const out = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.urls.wager,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
        MessageAttributeNames: ["All"],
      }),
      { abortSignal: this.abort.signal },
    );
    const messages = out.Messages ?? [];
    if (messages.length === 0) return 0;

    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? m.MessageId!;
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    const work = Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (this.stopping) await this.release(message);
          else await this.handle(message);
        }
      }),
    ).then(() => undefined);
    this.inFlight.add(work);
    try {
      await work;
    } finally {
      this.inFlight.delete(work);
    }
    return messages.length;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.stopping) break;
        this.logger.error("sqs poll failed", { worker: CONSUMER_NAME, err: describe(error) });
        await Bun.sleep(1_000);
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    let envelope: WagerTransactionRequested;
    try {
      envelope = parseOrThrow(wagerTransactionRequestedSchema, JSON.parse(message.Body ?? ""), "message");
    } catch (error) {
      const reason = error instanceof ValidationError ? "INVALID_MESSAGE" : "MALFORMED_JSON";
      await this.deadLetter(message, reason, error);
      return;
    }

    const correlationId = envelope.correlationId ?? envelope.messageId;
    await RequestContext.run({ correlationId, messageId: envelope.messageId }, async () => {
      try {
        const { idempotencyKey, ...payload } = envelope.data;
        await this.processWager.execute(
          { ...payload, idempotencyKey },
          {
            source: "sqs",
            correlationId,
            causationId: envelope.messageId,
            inbox: { consumerName: CONSUMER_NAME, messageId: envelope.messageId },
          },
        );
        faultPoint("consumer:after-commit-before-ack");
        await this.ack(message); // committed → safe to delete
      } catch (error) {
        const decision = classifyFailure(error);
        if (decision.action === "dead-letter") await this.deadLetter(message, decision.reason, error);
        else await this.retryLater(message, receiveCount, decision.reason, error);
      }
    });
  }

  private async ack(message: Message): Promise<void> {
    try {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.urls.wager, ReceiptHandle: message.ReceiptHandle }));
    } catch (error) {
      // Not fatal: the message will be redelivered and recognised by the inbox.
      this.logger.warn("ack failed; message will be redelivered and deduplicated", { err: describe(error) });
    }
  }

  private async retryLater(message: Message, receiveCount: number, reason: string, error: unknown): Promise<void> {
    this.metrics.retry("sqs_consumer");
    const exhausted = receiveCount >= this.config.maxReceiveCount;
    if (exhausted) this.metrics.deadLettered(`RETRIES_EXHAUSTED:${reason}`);
    const delay = retryDelaySeconds(receiveCount, this.config.retryBaseDelaySeconds, this.config.retryMaxDelaySeconds);
    this.logger.warn(exhausted ? "transient failure, retries exhausted; SQS will redrive to DLQ" : "transient failure, will retry", {
      reason,
      receiveCount,
      retryInSeconds: delay,
      err: describe(error),
    });
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: this.urls.wager, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: delay }),
      );
    } catch (visibilityError) {
      this.logger.warn("could not set retry backoff; default visibility timeout applies", { err: describe(visibilityError) });
    }
  }

  private async deadLetter(message: Message, reason: string, error: unknown): Promise<void> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.urls.dlq,
          MessageBody: message.Body ?? "",
          MessageGroupId: message.Attributes?.MessageGroupId ?? "dead-letter",
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            reason: { DataType: "String", StringValue: reason },
            error: { DataType: "String", StringValue: describe(error).message.slice(0, 1_000) || reason },
          },
        }),
      );
    } catch (sendError) {
      // Keep the message: it will be retried and eventually redriven by SQS.
      this.logger.error("could not dead-letter message; leaving it for redelivery", { reason, err: describe(sendError) });
      return;
    }
    this.metrics.deadLettered(reason);
    this.logger.warn("message dead-lettered", { reason, err: describe(error) });
    await this.ack(message);
  }

  private async release(message: Message): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: this.urls.wager, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }),
      );
    } catch {
      // visibility timeout will release it anyway
    }
  }
}

function describe(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
}
