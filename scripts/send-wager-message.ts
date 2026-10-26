import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

/**
 * Publishes a WagerTransactionRequested message to wager-transactions.fifo.
 *
 *   bun run scripts/send-wager-message.ts <walletId> <playerId> <kind> <amount> [referenceExternalTransactionId]
 *
 * Example: bun run scripts/send-wager-message.ts 0192f291-… player-1 BET 25.00
 */
const [walletId, playerId, kind = "BET", amount = "10.00", reference] = process.argv.slice(2);
if (!walletId || !playerId) {
  console.error("usage: bun run scripts/send-wager-message.ts <walletId> <playerId> <kind> <amount> [referenceExternalTransactionId]");
  process.exit(1);
}

const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: process.env.SQS_WAGER_QUEUE ?? "wager-transactions.fifo" }))).QueueUrl!;

const externalTransactionId = `cli-${Bun.randomUUIDv7()}`;
const message = {
  messageId: `msg-${externalTransactionId}`,
  type: "WagerTransactionRequested",
  occurredAt: new Date().toISOString(),
  data: {
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: "round-cli",
    gameId: "fortune-chimp",
    kind,
    money: { amount, currency: "BRL" },
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  },
};

await sqs.send(
  new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(message),
    MessageGroupId: walletId,
    MessageDeduplicationId: message.messageId,
  }),
);
console.log(JSON.stringify({ sent: message.messageId, externalTransactionId }, null, 2));
