import { z } from "zod";
import { ApplicationError } from "../../shared/application/errors";
import { DomainError } from "../../shared/domain/errors";
import { externalIdSchema } from "../../shared/http/validation";
import { idempotencyKeySchema, wagerTransactionPayloadSchema } from "../http/wagering.controller";

/** Contract of messages on wager-transactions.fifo (section 10). */
export const wagerTransactionRequestedSchema = z.strictObject({
  messageId: externalIdSchema(128),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.iso.datetime(),
  correlationId: externalIdSchema(128).optional(),
  data: wagerTransactionPayloadSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});
export type WagerTransactionRequested = z.infer<typeof wagerTransactionRequestedSchema>;

export type ConsumerDecision =
  | { action: "retry"; reason: string }
  | { action: "dead-letter"; reason: string };

/**
 * What to do with a message whose processing threw:
 * - transient infrastructure failure → retry later (visibility backoff), DLQ via redrive when exhausted;
 * - the request itself is wrong (validation, unknown wallet, idempotency conflict, domain refusal)
 *   → retrying can never help → dead-letter now;
 * - anything unexpected → retry (it may be an unrecognised transient error); redrive bounds it.
 * Business rejections never get here: they are successful (committed REJECTED) outcomes → ack.
 */
export function classifyFailure(error: unknown): ConsumerDecision {
  if (error instanceof ApplicationError) {
    return error.category === "transient"
      ? { action: "retry", reason: error.code }
      : { action: "dead-letter", reason: error.code };
  }
  if (error instanceof DomainError) return { action: "dead-letter", reason: error.code };
  return { action: "retry", reason: "UNEXPECTED_ERROR" };
}

/** Visibility delay before the n-th redelivery: min(base · 2^(n-1), max) seconds (SQS caps at 12h). */
export function retryDelaySeconds(receiveCount: number, baseSeconds: number, maxSeconds: number): number {
  return Math.min(Math.round(baseSeconds * 2 ** Math.max(receiveCount - 1, 0)), maxSeconds, 43_200);
}
