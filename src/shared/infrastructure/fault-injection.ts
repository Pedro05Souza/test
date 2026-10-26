export type FaultPoint = "consumer:after-commit-before-ack" | "outbox:after-claim-before-publish";

/**
 * Crash-test hook. Inert unless the FAULT_POINT environment variable names this point; then the
 * process kills itself with SIGKILL (no cleanup, no graceful shutdown) — exactly like a power
 * loss or OOM kill at the worst possible moment. Used by the multi-process recovery tests.
 */
export function faultPoint(point: FaultPoint): void {
  if (process.env.FAULT_POINT === point) process.kill(process.pid, "SIGKILL");
}
