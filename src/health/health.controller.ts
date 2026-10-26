import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";

export const HEALTH_CHECKS = Symbol("HealthChecks");

/** A dependency probed by /health/ready. `check` rejects when the dependency is unreachable. */
export interface HealthCheck {
  name: string;
  check(): Promise<void>;
}

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return Promise.race([
    promise,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref()),
  ]);
}

/** Health endpoints are deliberately unauthenticated. */
@Controller("health")
export class HealthController {
  constructor(@Inject(HEALTH_CHECKS) private readonly checks: HealthCheck[]) {}

  /** Liveness: the process is up and the event loop responds. No dependency checks. */
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Readiness: every dependency (PostgreSQL, SQS) is reachable. 503 otherwise. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const results = await Promise.all(
      this.checks.map(async ({ name, check }) => {
        try {
          await withTimeout(check(), CHECK_TIMEOUT_MS);
          return [name, { status: "up" }] as const;
        } catch (error) {
          return [name, { status: "down", error: error instanceof Error ? error.message : String(error) }] as const;
        }
      }),
    );
    const ready = results.every(([, r]) => r.status === "up");
    res.status(ready ? 200 : 503);
    return { status: ready ? "ready" : "not_ready", checks: Object.fromEntries(results) };
  }
}
