import { Inject, Injectable } from "@nestjs/common";
import {
  CLOCK,
  ID_GENERATOR,
  LOGGER,
  METRICS,
  UNIT_OF_WORK,
  type Clock,
  type IdGenerator,
  type Logger,
  type Metrics,
  type UnitOfWork,
} from "../../shared/application/ports";
import type { ReferenceRetryPolicy } from "../domain/reference-retry-policy";
import { WagerTransactionStatus } from "../domain/wager-transaction";
import { REFERENCE_RETRY_POLICY } from "./process-wager-transaction";
import { settleAndRecord } from "./settle-and-record";

export interface PendingReferenceRunResult {
  checked: number;
  processed: number;
  rejected: number;
  rescheduled: number;
  skipped: number;
}

type Outcome = "processed" | "rejected" | "rescheduled" | "skipped";

/**
 * Re-processes transactions waiting for a referenced transaction (section 7.1).
 *
 * Each candidate is handled in its own SQL transaction under the SAME wallet lock used by every
 * other operation, and is re-validated after locking (still PENDING_REFERENCE and still due), so
 * any number of instances may run this concurrently: the loser of a race simply skips.
 * Retries follow ReferenceRetryPolicy (exponential backoff); once exhausted the transaction is
 * REJECTED with REFERENCE_NOT_FOUND and a WagerTransactionRejected event is published.
 */
@Injectable()
export class ResolvePendingReferences {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(REFERENCE_RETRY_POLICY) private readonly retryPolicy: ReferenceRetryPolicy,
  ) {}

  async runOnce(limit = 50): Promise<PendingReferenceRunResult> {
    const due = await this.uow.run((repos) => repos.transactions.findDuePendingReferences(limit, this.clock.now()));
    const result: PendingReferenceRunResult = { checked: due.length, processed: 0, rejected: 0, rescheduled: 0, skipped: 0 };

    // Different wallets in parallel; one wallet's candidates sequentially (they would serialize anyway).
    const byWallet = new Map<string, string[]>();
    for (const { id, walletId } of due) byWallet.set(walletId, [...(byWallet.get(walletId) ?? []), id]);
    await Promise.all(
      [...byWallet].map(async ([walletId, ids]) => {
        for (const id of ids) {
          try {
            result[await this.resolve(id, walletId)] += 1;
          } catch (error) {
            // Transient (lock timeout, DB blip…): the row stays due and is picked up next tick.
            result.skipped += 1;
            this.logger.warn("pending reference check failed", {
              transactionId: id,
              walletId,
              err: error instanceof Error ? { name: error.name, message: error.message } : String(error),
            });
          }
        }
      }),
    );
    return result;
  }

  private resolve(transactionId: string, walletId: string): Promise<Outcome> {
    return this.uow.run(async (repos) => {
      const wallet = await repos.wallets.lockForUpdate(walletId);
      const tx = await repos.transactions.findById(transactionId);
      const now = this.clock.now();
      if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) return "skipped";
      if (tx.nextReferenceCheckAt && tx.nextReferenceCheckAt > now) return "skipped"; // another instance got here first

      await settleAndRecord({
        repos,
        wallet,
        transaction: tx,
        isNew: false,
        trace: { correlationId: tx.id, causationId: `pending-reference-check:${tx.referenceAttempts + 1}` },
        ids: this.ids,
        retryPolicy: this.retryPolicy,
        now,
      });

      const fields = {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        kind: tx.kind,
        status: tx.status,
        attempts: tx.referenceAttempts,
        failureCode: tx.failureCode,
      };
      // settleAndRecord transitioned the aggregate; re-read the status without the earlier narrowing.
      const status = tx.status as WagerTransactionStatus;
      switch (status) {
        case WagerTransactionStatus.Processed:
          this.metrics.transactionOutcome(tx.status, tx.kind, "worker");
          this.logger.info("pending reference resolved", fields);
          return "processed";
        case WagerTransactionStatus.Rejected:
          this.metrics.transactionOutcome(tx.status, tx.kind, "worker");
          this.logger.warn("pending reference rejected", fields);
          return "rejected";
        default:
          this.metrics.retry("pending_reference");
          this.logger.debug("reference still missing, rescheduled", { ...fields, nextCheckAt: tx.nextReferenceCheckAt?.toISOString() });
          return "rescheduled";
      }
    });
  }
}
