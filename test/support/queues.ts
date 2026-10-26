import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";

export const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

export interface IsolatedQueues {
  env: Record<string, string>;
  wagerUrl: string;
  dlqUrl: string;
  eventsUrl: string;
}

/** Fresh FIFO queues for one test file (input + DLQ with redrive, events). */
export async function createIsolatedQueues(prefix: string, maxReceiveCount = 3, visibilityTimeoutSeconds = 30): Promise<IsolatedQueues> {
  const id = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const create = async (name: string, attributes: Record<string, string> = {}) =>
    (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: { FifoQueue: "true", VisibilityTimeout: String(visibilityTimeoutSeconds), ...attributes },
        }),
      )
    ).QueueUrl!;
  const dlqName = `${id}-dlq.fifo`;
  const dlqUrl = await create(dlqName);
  const dlqArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
  const wagerName = `${id}-wager.fifo`;
  const wagerUrl = await create(wagerName, {
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(maxReceiveCount) }),
  });
  const eventsName = `${id}-events.fifo`;
  const eventsUrl = await create(eventsName);
  return {
    wagerUrl,
    dlqUrl,
    eventsUrl,
    env: {
      SQS_WAGER_QUEUE: wagerName,
      SQS_WAGER_DLQ: dlqName,
      SQS_EVENTS_QUEUE: eventsName,
      SQS_MAX_RECEIVE_COUNT: String(maxReceiveCount),
    },
  };
}

export async function send(queueUrl: string, body: unknown, opts: { groupId: string; dedupId?: string }) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === "string" ? body : JSON.stringify(body),
      MessageGroupId: opts.groupId,
      MessageDeduplicationId: opts.dedupId ?? Bun.randomUUIDv7(),
    }),
  );
}

/** Receives everything currently visible (and deletes it), optionally with attributes. */
export async function drain(queueUrl: string, waitSeconds = 1): Promise<Message[]> {
  const all: Message[] = [];
  for (;;) {
    const out = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["All"],
      }),
    );
    const batch = out.Messages ?? [];
    if (batch.length === 0) return all;
    all.push(...batch);
    for (const m of batch) await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
  }
}

export async function queueDepth(queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const out = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return {
    visible: Number(out.Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

export function wagerMessage(data: Record<string, unknown>, messageId = `msg-${Bun.randomUUIDv7()}`) {
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: { idempotencyKey: `${data.providerId}:${data.externalTransactionId}`, ...data },
  };
}

export async function waitFor<T>(probe: () => Promise<T | undefined | false>, timeoutMs = 10_000, everyMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await Bun.sleep(everyMs);
  }
}
