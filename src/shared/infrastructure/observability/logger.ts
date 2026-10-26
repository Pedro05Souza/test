import { hostname } from "node:os";
import { pino, type Logger as PinoLogger } from "pino";
import type { Logger } from "../../application/ports";
import { RequestContext } from "./request-context";

/**
 * Structured JSON logs (pino). Request-scoped tracing fields (correlationId, messageId) are mixed
 * into every line. Financial values and payloads are redacted as a safety net: call sites log
 * identifiers (transactionId, walletId, providerId) and outcomes, never amounts or bodies.
 */
export class PinoAppLogger implements Logger {
  constructor(private readonly log: PinoLogger) {}

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log.debug(fields ?? {}, msg);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log.info(fields ?? {}, msg);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log.warn(fields ?? {}, msg);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log.error(fields ?? {}, msg);
  }
}

const REDACTED_PATHS = [
  "money", "balance", "amount", "payload", "body", "data",
  "*.money", "*.balance", "*.amount", "*.payload", "*.body", "*.data",
  "initialBalance", "storedBalance", "calculatedBalance", "difference",
  "headers.authorization",
];

export function createLogger(
  level = process.env.LOG_LEVEL ?? "info",
  destination?: pino.DestinationStream,
): Logger {
  const log = pino(
    {
    level,
    base: { service: "wagering-processor", pid: process.pid, instance: process.env.INSTANCE_ID ?? hostname() },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    messageKey: "msg",
    mixin: () => ({ ...RequestContext.get() }),
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    serializers: { err: pino.stdSerializers.err },
    },
    destination,
  );
  return new PinoAppLogger(log);
}
