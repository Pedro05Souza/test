import { LockMode, type EntityManager } from "@mikro-orm/postgresql";
import type { Metrics } from "../../shared/application/ports";
import { Money } from "../../shared/domain/money";
import { isUuid } from "../../shared/uuid";
import type {
  LedgerPageItem,
  LedgerReconciliationSnapshot,
  LedgerRepository,
  WalletRepository,
} from "../application/ports";
import type { Wallet } from "../domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { WalletLedgerEntryRecord } from "./wallet-ledger-entry.record";
import { LedgerEntryMapper, WalletMapper } from "./wallet.mapper";
import { WalletRecord } from "./wallet.record";

export class MikroOrmWalletRepository implements WalletRepository {
  /** Managed records loaded in this unit of work, so `save` updates them in place. */
  private readonly records = new Map<string, WalletRecord>();

  constructor(
    private readonly em: EntityManager,
    private readonly metrics: Metrics,
  ) {}

  async lockForUpdate(walletId: string): Promise<Wallet | null> {
    if (!isUuid(walletId)) return null;
    if (!(await this.tryLockWithoutWaiting(walletId))) this.metrics.lockConflict("wallet");
    // Blocking lock (re-entrant if the probe already got it); bounded by SET LOCAL lock_timeout.
    const record = await this.em.findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    if (!record) return null;
    this.records.set(record.id, record);
    return WalletMapper.toDomain(record);
  }

  async findById(walletId: string): Promise<Wallet | null> {
    if (!isUuid(walletId)) return null;
    const record = await this.em.findOne(WalletRecord, { id: walletId });
    return record ? WalletMapper.toDomain(record) : null;
  }

  add(wallet: Wallet): void {
    this.records.set(wallet.id, this.em.create(WalletRecord, WalletMapper.toRecord(wallet)));
  }

  save(wallet: Wallet): void {
    const record = this.records.get(wallet.id);
    if (!record) throw new Error(`wallet ${wallet.id} was not loaded for update in this unit of work`);
    // change tracking diffs managed records against their loaded snapshot at flush
    Object.assign(record, WalletMapper.toRecord(wallet));
  }

  /**
   * FOR UPDATE NOWAIT inside a savepoint: tells us whether someone else holds the row lock
   * (contention metric) without aborting the surrounding transaction when it fails.
   */
  private async tryLockWithoutWaiting(walletId: string): Promise<boolean> {
    await this.em.execute("SAVEPOINT wallet_lock_probe");
    try {
      await this.em.execute("SELECT 1 FROM wallets WHERE id = ? FOR UPDATE NOWAIT", [walletId]);
      await this.em.execute("RELEASE SAVEPOINT wallet_lock_probe");
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== "55P03") throw error;
      await this.em.execute("ROLLBACK TO SAVEPOINT wallet_lock_probe");
      return false;
    }
  }
}

interface LedgerRow {
  seq: string;
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  add(entry: WalletLedgerEntry): void {
    this.em.create(WalletLedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
  }

  async page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPageItem[]> {
    const rows = await this.em.execute<LedgerRow[]>(
      `SELECT seq::text AS seq, id, wallet_id, transaction_id, direction, amount, currency,
              balance_before, balance_after, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ? AND seq > ?
        ORDER BY seq
        LIMIT ?`,
      [walletId, afterSeq ?? "0", limit],
    );
    return rows.map((row) => {
      const money = (amount: string) => Money.from({ amount, currency: row.currency });
      return {
        seq: row.seq,
        entry: WalletLedgerEntry.rehydrate({
          id: row.id,
          walletId: row.wallet_id,
          transactionId: row.transaction_id,
          direction: row.direction as LedgerDirection,
          money: money(row.amount),
          balanceBefore: money(row.balance_before),
          balanceAfter: money(row.balance_after),
          createdAt: new Date(row.created_at),
        }),
      };
    });
  }

  async reconciliationSnapshot(walletId: string): Promise<LedgerReconciliationSnapshot | null> {
    // One statement = one MVCC snapshot: stored and calculated balances are mutually consistent.
    const [row] = await this.em.execute<{ stored: string; currency: string; calculated: string; entries: number }[]>(
      `SELECT w.balance_amount::text AS stored,
              w.currency,
              COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS calculated,
              COUNT(l.id)::int AS entries
         FROM wallets w
         LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ?
        GROUP BY w.id`,
      [walletId],
    );
    if (!row) return null;
    return {
      storedBalance: parseSigned(row.stored, row.currency),
      calculatedBalance: parseSigned(row.calculated, row.currency),
      checkedEntries: row.entries,
    };
  }
}

/** Reconciliation must be able to represent a (corrupt) negative sum instead of failing to parse it. */
function parseSigned(amount: string, currency: string): Money {
  return amount.startsWith("-")
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}
