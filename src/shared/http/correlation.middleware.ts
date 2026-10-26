import type { NextFunction, Request, Response } from "express";
import type { Logger } from "../application/ports";
import { RequestContext } from "../infrastructure/observability/request-context";

export const CORRELATION_HEADER = "x-correlation-id";
const VALID_ID = /^[\w.:-]{1,128}$/;

/**
 * Accepts the caller's correlation id (or creates one), echoes it, binds it to the request's
 * async context, and writes one access-log line per request (no bodies, no query strings).
 */
export function correlationMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(CORRELATION_HEADER);
    const correlationId = incoming && VALID_ID.test(incoming) ? incoming : Bun.randomUUIDv7();
    const requestId = Bun.randomUUIDv7();
    const startedAt = performance.now();
    res.setHeader(CORRELATION_HEADER, correlationId);
    RequestContext.run({ correlationId, requestId }, () => {
      res.on("finish", () => {
        if (req.path === "/metrics" || req.path.startsWith("/health")) return;
        logger.info("http request", {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        });
      });
      next();
    });
  };
}

export function currentTrace(): { correlationId: string; causationId?: string } {
  const { correlationId, requestId } = RequestContext.get();
  return { correlationId: correlationId ?? Bun.randomUUIDv7(), ...(requestId ? { causationId: requestId } : {}) };
}
