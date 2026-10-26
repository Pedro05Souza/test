import type { Money } from "../../shared/domain/money";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export interface WalletRepository {
  /**
   * Loads the wallet and takes an exclusive row lock (SELECT … FOR UPDATE) held until the
   * transaction ends. This is THE concurrency control: operations on the same wallet serialize,
   * different wallets proceed in parallel, across any number of instances.
   */
  lockForUpdate(walletId: string): Promise<Wallet | null>;
  findById(walletId: string): Promise<Wallet | null>;
  add(wallet: Wallet): void;
  /** Persists balance/version changes of a wallet previously loaded with lockForUpdate. */
  save(wallet: Wallet): void;
}

export interface LedgerPageItem {
  entry: WalletLedgerEntry;
  /** Position in the wallet ledger (monotonic); basis of the opaque cursor. */
  seq: string;
}

export interface LedgerReconciliationSnapshot {
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
}

export interface LedgerRepository {
  add(entry: WalletLedgerEntry): void;
  /** Entries with seq > afterSeq, ascending, at most `limit`. */
  page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPageItem[]>;
  /** Stored balance and ledger-derived balance read in a single statement (one consistent snapshot). */
  reconciliationSnapshot(walletId: string): Promise<LedgerReconciliationSnapshot | null>;
}
