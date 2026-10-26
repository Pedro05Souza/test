import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

/**
 * Idempotent bootstrap of the FIFO queues used by the service.
 * CreateQueue with identical attributes is a no-op on SQS, so this can run on every `compose up`.
 */
const endpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
const maxReceiveCount = process.env.SQS_MAX_RECEIVE_COUNT ?? "5";

const sqs = new SQSClient({
  endpoint,
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

async function createFifo(name: string, attributes: Record<string, string> = {}): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = await sqs.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: { FifoQueue: "true", VisibilityTimeout: "30", ...attributes },
        }),
      );
      return out.QueueUrl!;
    } catch (err) {
      if (attempt >= 30) throw err;
      await Bun.sleep(1000); // emulator may still be booting
    }
  }
}

const dlqUrl = await createFifo("wager-transactions-dlq.fifo");
const dlqArn = (
  await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }))
).Attributes!.QueueArn!;

await createFifo("wager-transactions.fifo", {
  RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount }),
});
await createFifo("wagering-events.fifo", { ContentBasedDeduplication: "false" });

console.log(JSON.stringify({ msg: "queues ready", endpoint, dlqArn }));
