import { describe, expect, test } from "bun:test";
import {
  IdempotencyConflictError,
  TransientInfrastructureError,
  ValidationError,
  WalletNotFoundError,
} from "../../src/shared/application/errors";
import { InvalidMoneyError } from "../../src/shared/domain/errors";
import { classifyFailure, retryDelaySeconds } from "../../src/wagering/sqs/wager-message";

describe("SQS consumer failure policy", () => {
  test("transient infrastructure errors are retried", () => {
    expect(classifyFailure(new TransientInfrastructureError("db down"))).toEqual({ action: "retry", reason: "TEMPORARILY_UNAVAILABLE" });
  });

  test("errors that retrying cannot fix are dead-lettered immediately", () => {
    expect(classifyFailure(new ValidationError("bad")).action).toBe("dead-letter");
    expect(classifyFailure(new WalletNotFoundError("x"))).toEqual({ action: "dead-letter", reason: "WALLET_NOT_FOUND" });
    expect(classifyFailure(new IdempotencyConflictError("x"))).toEqual({ action: "dead-letter", reason: "IDEMPOTENCY_CONFLICT" });
    expect(classifyFailure(new InvalidMoneyError("x"))).toEqual({ action: "dead-letter", reason: "INVALID_MONEY" });
  });

  test("unknown errors are retried (bounded by the queue's maxReceiveCount)", () => {
    expect(classifyFailure(new Error("boom"))).toEqual({ action: "retry", reason: "UNEXPECTED_ERROR" });
  });

  test("visibility backoff doubles per receive and is capped", () => {
    expect([1, 2, 3, 4, 5].map((n) => retryDelaySeconds(n, 2, 300))).toEqual([2, 4, 8, 16, 32]);
    expect(retryDelaySeconds(20, 2, 300)).toBe(300);
    expect(retryDelaySeconds(40, 2, 1e9)).toBe(43_200); // SQS maximum
  });
});
