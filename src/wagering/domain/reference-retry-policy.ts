/**
 * Backoff for transactions waiting on a referenced transaction that has not arrived yet.
 *
 * Defaults: 10 attempts, delay 2s · 2^(n-1) capped at 5 min →
 * 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 300s, 300s ≈ 18.5 min total.
 * Providers deliver out-of-order messages within seconds; a reference still missing after
 * ~18 minutes is almost certainly never coming, and holding the round open longer only delays
 * the provider's own reconciliation.
 */
export class ReferenceRetryPolicy {
  constructor(
    readonly maxAttempts = 10,
    readonly baseDelayMs = 2_000,
    readonly maxDelayMs = 300_000,
  ) {}

  /** Delay before check number `attempt` (1-based). */
  delayFor(attempt: number): number {
    return Math.min(this.baseDelayMs * 2 ** Math.max(attempt - 1, 0), this.maxDelayMs);
  }

  isExhausted(attempts: number): boolean {
    return attempts >= this.maxAttempts;
  }
}
