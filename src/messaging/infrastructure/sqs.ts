import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { MessagingConfig } from "../../shared/infrastructure/config";

export const SQS_CLIENT = Symbol("SQSClient");
export const QUEUE_URLS = Symbol("QueueUrls");

export interface QueueUrls {
  wager: string;
  dlq: string;
  events: string;
}

export function createSqsClient(config: MessagingConfig): SQSClient {
  return new SQSClient({
    endpoint: config.sqsEndpoint,
    region: config.region,
    // Local emulator; in AWS the default credential provider chain applies.
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? undefined
      : { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 3,
  });
}

/** Resolves queue URLs once at startup; retries while the broker is still coming up. */
export async function resolveQueueUrls(sqs: SQSClient, config: MessagingConfig, attempts = 30): Promise<QueueUrls> {
  for (let attempt = 1; ; attempt++) {
    try {
      const url = async (QueueName: string) => (await sqs.send(new GetQueueUrlCommand({ QueueName }))).QueueUrl!;
      return { wager: await url(config.wagerQueue), dlq: await url(config.wagerDlq), events: await url(config.eventsQueue) };
    } catch (error) {
      if (attempt >= attempts) throw error;
      await Bun.sleep(1_000);
    }
  }
}

export async function checkSqs(sqs: SQSClient, urls: QueueUrls): Promise<void> {
  await sqs.send(new GetQueueAttributesCommand({ QueueUrl: urls.wager, AttributeNames: ["QueueArn"] }));
}
