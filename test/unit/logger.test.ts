import { describe, expect, test } from "bun:test";
import { createLogger } from "../../src/shared/infrastructure/observability/logger";
import { RequestContext } from "../../src/shared/infrastructure/observability/request-context";

function capture() {
  const lines: Record<string, any>[] = [];
  const logger = createLogger("debug", { write: (chunk: string) => void lines.push(JSON.parse(chunk)) });
  return { logger, lines };
}

describe("structured logger", () => {
  test("emits JSON with level, ISO time, service and request-scoped tracing fields", () => {
    const { logger, lines } = capture();
    RequestContext.run({ correlationId: "corr-1", messageId: "msg-1" }, () =>
      logger.info("wager transaction handled", { transactionId: "t-1", walletId: "w-1", providerId: "p-1" }),
    );
    expect(lines[0]).toMatchObject({
      level: "info",
      service: "wagering-processor",
      msg: "wager transaction handled",
      correlationId: "corr-1",
      messageId: "msg-1",
      transactionId: "t-1",
      walletId: "w-1",
      providerId: "p-1",
    });
    expect(new Date(lines[0]!.time).toISOString()).toBe(lines[0]!.time);
  });

  test("redacts financial values and payloads even if a call site passes them by mistake", () => {
    const { logger, lines } = capture();
    logger.warn("oops", {
      money: { amount: "25.00", currency: "BRL" },
      balance: { amount: "975.00", currency: "BRL" },
      payload: { secret: true },
      nested: { amount: "1.00", data: { x: 1 } },
      transactionId: "t-1",
    });
    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain("25.00");
    expect(line).not.toContain("975.00");
    expect(line).not.toContain("secret");
    expect(lines[0]).toMatchObject({ money: "[redacted]", balance: "[redacted]", payload: "[redacted]", transactionId: "t-1" });
    expect(lines[0]!.nested).toEqual({ amount: "[redacted]", data: "[redacted]" });
  });
});
