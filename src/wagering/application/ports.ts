import type { WagerTransaction } from "../domain/wager-transaction";

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** Whether a PROCESSED REFUND/ROLLBACK already points to `referenceTransactionId`. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /**
   * PENDING_REFERENCE transactions whose next check is due (oldest first). A plain read: the
   * worker re-validates each candidate under the wallet lock before acting on it.
   */
  findDuePendingReferences(limit: number, now: Date): Promise<{ id: string; walletId: string }[]>;
  /** Makes PENDING_REFERENCE transactions of the same wallet that reference `processed` due now. */
  wakeDependents(processed: WagerTransaction, now: Date): Promise<number>;
  add(transaction: WagerTransaction): void;
  /** Persists state changes of a transaction previously loaded in this unit of work. */
  save(transaction: WagerTransaction): void;
}
