import type { EntityManager, FilterQuery } from "@mikro-orm/postgresql";
import { isUuid } from "../../shared/uuid";
import type { WagerTransactionRepository } from "../application/ports";
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from "../domain/wager-transaction";
import { WagerTransactionMapper } from "./wager-transaction.mapper";
import { WagerTransactionRecord } from "./wager-transaction.record";

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  private readonly records = new Map<string, WagerTransactionRecord>();

  constructor(
    private readonly em: EntityManager,
    private readonly now: () => Date,
  ) {}

  findById(id: string): Promise<WagerTransaction | null> {
    if (!isUuid(id)) return Promise.resolve(null);
    return this.findOne({ id });
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    return this.findOne({ idempotencyKey });
  }

  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransaction: referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  async findDuePendingReferences(limit: number, now: Date): Promise<{ id: string; walletId: string }[]> {
    const rows = await this.em.execute<{ id: string; wallet_id: string }[]>(
      `SELECT id, wallet_id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_reference_check_at <= ?
        ORDER BY next_reference_check_at
        LIMIT ?`,
      [now, limit],
    );
    return rows.map((r) => ({ id: r.id, walletId: r.wallet_id }));
  }

  async wakeDependents(processed: WagerTransaction, now: Date): Promise<number> {
    const rows = await this.em.execute<{ id: string }[]>(
      `UPDATE wager_transactions
          SET next_reference_check_at = ?, updated_at = ?
        WHERE status = 'PENDING_REFERENCE'
          AND wallet_id = ? AND provider_id = ? AND reference_external_transaction_id = ?
          AND next_reference_check_at > ?
       RETURNING id`,
      [now, now, processed.walletId, processed.providerId, processed.externalTransactionId, now],
    );
    return rows.length;
  }

  add(transaction: WagerTransaction): void {
    const record = this.em.create(WagerTransactionRecord, WagerTransactionMapper.toRecord(transaction, this.now()));
    this.records.set(transaction.id, record);
  }

  save(transaction: WagerTransaction): void {
    const record = this.records.get(transaction.id);
    if (!record) throw new Error(`transaction ${transaction.id} was not loaded in this unit of work`);
    // change tracking diffs managed records against their loaded snapshot at flush
    Object.assign(record, WagerTransactionMapper.toRecord(transaction, this.now()));
  }

  private async findOne(where: FilterQuery<WagerTransactionRecord>): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionRecord, where, { refresh: true });
    if (!record) return null;
    this.records.set(record.id, record);
    return WagerTransactionMapper.toDomain(record);
  }
}
